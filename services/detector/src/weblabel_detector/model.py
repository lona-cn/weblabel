"""RT-DETR v2 model pinning, post-processing and probe policy.

``decode_detections`` is pure Python over raw model outputs (``pred_boxes``
normalized cxcywh + ``pred_logits``) and is the single decoding path used both
by the offline tests (synthetic mock tensors — post-processing evidence only)
and by real inference. Exactly one inverse scaling maps model-input pixels back
to original pixels (``geometry.inverse``), and the canonical mapping is then
applied via ``transform_to_canonical``; a second post-process target-size
scaling is never applied.

Loading the pinned weights and executing them is T32's gate. This module makes
that path real (hash-verified, local-files-only loading) but T18 does not and
cannot claim execution evidence for it.
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import math
import platform
import re
from dataclasses import dataclass, field
from pathlib import Path

from .labels import MAX_CATEGORY_LENGTH
from .transforms import DetectorError, apply_matrix, clamp_bbox

__all__ = [
    "MAX_CLASSES",
    "MAX_DETECTIONS",
    "MAX_QUERIES",
    "SCORE_THRESHOLD",
    "ConfigurationError",
    "DecodeResult",
    "DecodeStats",
    "Detection",
    "DetectorError",
    "Predictor",
    "ProbeStatus",
    "UnsupportedDetection",
    "WeightsError",
    "build_candidate_raw",
    "check_runtime",
    "compose_probe",
    "decode_detections",
    "load_models_lock",
    "probe_status",
    "project_detections",
    "verify_weights",
]

MAX_QUERIES = 4096
MAX_CLASSES = 512
MAX_DETECTIONS = 300
SCORE_THRESHOLD = 0.5
MAX_LOCK_FILES = 64
_HASH_CHUNK = 1024 * 1024
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class ConfigurationError(DetectorError):
    """The detector is not configured (missing lock/weights/runtime)."""


class WeightsError(DetectorError):
    """Pinned weight files exist but do not match the lock."""


@dataclass(frozen=True)
class Detection:
    label_id: str
    category: str
    score: float
    bbox_xyxy: tuple[float, float, float, float]


@dataclass(frozen=True)
class UnsupportedDetection:
    category: str | None
    detector_index: int
    score: float
    bbox_xyxy: tuple[float, float, float, float] | None = None


@dataclass(frozen=True)
class DecodeStats:
    queries: int
    dropped_non_finite: int
    dropped_below_threshold: int
    dropped_degenerate: int
    truncated_to_max: int


@dataclass(frozen=True)
class DecodeResult:
    detections: tuple[Detection, ...] = ()
    unsupported: tuple[UnsupportedDetection, ...] = ()
    stats: DecodeStats = field(default_factory=lambda: DecodeStats(0, 0, 0, 0, 0))


@dataclass(frozen=True)
class ProbeStatus:
    model_id: str
    weights_ok: bool
    weights_error: str | None
    missing_runtime: tuple[str, ...]


# ---------------------------------------------------------------------------
# models.lock.json pinning
# ---------------------------------------------------------------------------


def load_models_lock(path):
    """Load and validate the pinned weights lock. A missing or malformed lock
    is a configuration problem (``needs_configuration``), never guessed."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as error:
        raise ConfigurationError("needs_configuration", f"models lock not found: {error}") from error
    try:
        lock = json.loads(text)
    except ValueError as error:
        raise ConfigurationError("needs_configuration", f"models lock is not valid JSON: {error}") from error
    if not isinstance(lock, dict) or lock.get("schema_version") != 1:
        raise ConfigurationError("needs_configuration", "models lock must be schema_version 1")
    model_id = lock.get("model_id")
    if not isinstance(model_id, str) or model_id == "":
        raise ConfigurationError("needs_configuration", "models lock is missing model_id")
    files = lock.get("files")
    if not isinstance(files, list) or not files or len(files) > MAX_LOCK_FILES:
        raise ConfigurationError("needs_configuration", "models lock must pin between 1 and 64 files")
    for entry in files:
        if not isinstance(entry, dict):
            raise ConfigurationError("needs_configuration", "models lock file entries must be objects")
        rel = entry.get("path")
        if not isinstance(rel, str) or rel == "" or Path(rel).is_absolute() or ".." in Path(rel).parts or "/" in rel or "\\" in rel:
            raise ConfigurationError("needs_configuration", "models lock file paths must be plain file names")
        if not isinstance(entry.get("bytes"), int) or entry["bytes"] < 0:
            raise ConfigurationError("needs_configuration", f"models lock entry {rel!r} needs a byte count")
        digest = entry.get("sha256")
        if not isinstance(digest, str) or _SHA256_RE.match(digest) is None:
            raise ConfigurationError("needs_configuration", f"models lock entry {rel!r} needs a sha256 digest")
        if not isinstance(entry.get("role"), str) or entry["role"] == "":
            raise ConfigurationError("needs_configuration", f"models lock entry {rel!r} needs a role")
    return lock


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(_HASH_CHUNK)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def verify_weights(lock, weights_dir):
    """Verify every pinned file in ``weights_dir`` against its locked sha256.
    Missing files -> ``needs_configuration``; any mismatch -> ``weights_hash_mismatch``."""
    root = Path(weights_dir)
    missing: list[str] = []
    for entry in lock["files"]:
        target = root / entry["path"]
        if not target.is_file():
            missing.append(entry["path"])
    if missing:
        raise ConfigurationError("needs_configuration", f"weights missing: {', '.join(sorted(missing))}")
    for entry in lock["files"]:
        target = root / entry["path"]
        size = target.stat().st_size
        if size != entry["bytes"] or _sha256_file(target) != entry["sha256"]:
            raise WeightsError("weights_hash_mismatch", f"pinned file {entry['path']} does not match models.lock.json")
    return None


def _missing_runtime(find_spec=None) -> tuple[str, ...]:
    spec_finder = find_spec if find_spec is not None else importlib.util.find_spec
    return tuple(name for name in ("torch", "transformers") if spec_finder(name) is None)


def check_runtime(find_spec=None):
    """Ensure the real-inference Python runtime is importable."""
    missing = _missing_runtime(find_spec)
    if missing:
        raise ConfigurationError("needs_configuration", f"missing runtime: {', '.join(missing)}")
    return None


def probe_status(lock_path, weights_dir, *, find_spec=None):
    """Two honest dimensions: pinned-weights state and runtime state."""
    model_id = "unknown"
    try:
        lock = load_models_lock(lock_path)
        model_id = lock["model_id"]
        verify_weights(lock, weights_dir)
        weights_ok, weights_error = True, None
    except DetectorError as error:
        weights_ok, weights_error = False, error.message
    return ProbeStatus(model_id=model_id, weights_ok=weights_ok, weights_error=weights_error, missing_runtime=_missing_runtime(find_spec))


def compose_probe(model_id, *, weights_ok, weights_error, missing_runtime):
    """Wire-shaped ModelProfile. The verification dimension is always
    ``not_run`` from T18: mock tensors are post-processing evidence only and
    real weight execution is T32's gate, so no mock/live claim is possible."""
    ready = bool(weights_ok) and not missing_runtime
    return {
        "profile_id": "detector_local",
        "provider_id": "detector_local",
        "model_id": model_id,
        "auth_kind": "local_weights",
        "capabilities": {
            "image_input": True,
            "tools": False,
            "structured_output": True,
            "bbox_output": True,
            "attributes": False,
        },
        "availability": "ready" if ready else "needs_configuration",
        "verification": "not_run",
        "runtime_version": f"CPython {platform.python_version()}",
        "verified_at": None,
    }


# ---------------------------------------------------------------------------
# Post-processing (synthetic mock tensors exercise exactly this code)
# ---------------------------------------------------------------------------


def _sigmoid(value: float) -> float:
    if value >= 0.0:
        return 1.0 / (1.0 + math.exp(-value))
    exponential = math.exp(value)
    return exponential / (1.0 + exponential)


def _normalize_id2label(id2label) -> dict[int, str]:
    if not isinstance(id2label, dict):
        raise DetectorError("invalid_input", "id2label must be a mapping of class index -> category")
    normalized: dict[int, str] = {}
    for key, value in id2label.items():
        try:
            index = int(key)
        except (TypeError, ValueError) as error:
            raise DetectorError("invalid_input", "id2label keys must be class indices") from error
        if not isinstance(value, str):
            raise DetectorError("invalid_input", "id2label values must be category names")
        if len(value) > MAX_CATEGORY_LENGTH:
            raise DetectorError("invalid_input", "id2label category names exceed the length limit")
        normalized[index] = value
    return normalized


def decode_detections(
    *,
    raw_boxes,
    raw_logits,
    id2label,
    geometry,
    label_mapping,
    score_threshold=SCORE_THRESHOLD,
    max_detections=MAX_DETECTIONS,
):
    """Decode raw model queries into original-pixel detections.

    raw_boxes: per-query normalized cxcywh (RT-DETR ``pred_boxes`` layout).
    raw_logits: per-query raw class logits (RT-DETR ``pred_logits`` layout).
    geometry: preprocessing geometry exposing ``input_width``/``input_height``
    and ``inverse`` (model-input pixels -> original pixels) — the ONE inverse
    scaling point for the model box.

    Non-finite queries are dropped and counted; boxes are clamped to legal
    bounds; degenerate boxes are dropped; output lists are hard-capped at
    ``max_detections`` so memory stays bounded no matter how many queries the
    model emits. Categories without an explicit mapping are REPORTED, never
    guessed.
    """
    if isinstance(max_detections, bool) or not isinstance(max_detections, int) or not (1 <= max_detections <= MAX_DETECTIONS):
        raise DetectorError("invalid_max_detections", f"max_detections must be in 1..{MAX_DETECTIONS}")
    try:
        threshold = float(score_threshold)
    except (TypeError, ValueError) as error:
        raise DetectorError("invalid_threshold", "score_threshold must be a number") from error
    if not math.isfinite(threshold):
        raise DetectorError("invalid_threshold", "score_threshold must be finite")
    index_to_category = _normalize_id2label(id2label)
    try:
        boxes = list(raw_boxes)
        logits = list(raw_logits)
    except TypeError as error:
        raise DetectorError("invalid_input", "raw_boxes and raw_logits must be sequences") from error
    if len(boxes) != len(logits):
        raise DetectorError("invalid_input", "raw_boxes and raw_logits must have the same number of queries")
    queries = len(boxes)
    if queries > MAX_QUERIES:
        raise DetectorError("input_too_large", f"{queries} queries exceed the {MAX_QUERIES} budget")
    class_count: int | None = None
    detections: list[Detection] = []
    unsupported: list[UnsupportedDetection] = []
    dropped_non_finite = 0
    dropped_below_threshold = 0
    dropped_degenerate = 0
    for box_row, logit_row in zip(boxes, logits):
        try:
            box_values = [float(v) for v in box_row]
            logit_values = [float(v) for v in logit_row]
        except (TypeError, ValueError) as error:
            raise DetectorError("invalid_input", "raw outputs must be numeric") from error
        if class_count is None:
            class_count = len(logit_values)
            if class_count > MAX_CLASSES:
                raise DetectorError("input_too_large", f"{class_count} classes exceed the {MAX_CLASSES} budget")
        if len(logit_values) != class_count:
            raise DetectorError("invalid_input", "every query must carry the same number of class logits")
        if len(box_values) != 4:
            raise DetectorError("invalid_input", "every query must carry a 4-value cxcywh box")
        if not all(math.isfinite(v) for v in box_values) or not all(math.isfinite(v) for v in logit_values):
            dropped_non_finite += 1
            continue
        best = -math.inf
        best_index = -1
        for index, value in enumerate(logit_values):
            score = _sigmoid(value)
            if score > best:
                best = score
                best_index = index
        if best < threshold:
            dropped_below_threshold += 1
            continue
        cx, cy, w, h = box_values
        input_box = [
            (cx - w / 2.0) * geometry.input_width,
            (cy - h / 2.0) * geometry.input_height,
            (cx + w / 2.0) * geometry.input_width,
            (cy + h / 2.0) * geometry.input_height,
        ]
        original = geometry.inverse(input_box)
        x_min, y_min, x_max, y_max = _clamp(original, geometry.width, geometry.height)
        if x_max <= x_min or y_max <= y_min:
            dropped_degenerate += 1
            continue
        bbox = (x_min, y_min, x_max, y_max)
        category = index_to_category.get(best_index)
        label_id = label_mapping.map_category(category) if category is not None else None
        if label_id is None:
            unsupported.append(UnsupportedDetection(category=category, detector_index=best_index, score=best, bbox_xyxy=bbox))
        else:
            detections.append(Detection(label_id=label_id, category=category, score=best, bbox_xyxy=bbox))
    detections.sort(key=lambda item: item.score, reverse=True)
    unsupported.sort(key=lambda item: item.score, reverse=True)
    truncated = max(0, len(detections) - max_detections) + max(0, len(unsupported) - max_detections)
    return DecodeResult(
        detections=tuple(detections[:max_detections]),
        unsupported=tuple(unsupported[:max_detections]),
        stats=DecodeStats(
            queries=queries,
            dropped_non_finite=dropped_non_finite,
            dropped_below_threshold=dropped_below_threshold,
            dropped_degenerate=dropped_degenerate,
            truncated_to_max=truncated,
        ),
    )


def _clamp(box, width, height):
    return clamp_bbox(box, width, height)


def project_detections(result, *, transform_to_canonical, canonical_width, canonical_height):
    """Map decoded original-pixel detections into canonical continuous pixels
    via the granted ``transform_to_canonical`` matrix, then clamp to canonical
    bounds. Degenerate projections are dropped, never emitted."""
    detections: list[Detection] = []
    unsupported: list[UnsupportedDetection] = []
    for det in result.detections:
        moved = clamp_bbox(apply_matrix(transform_to_canonical, det.bbox_xyxy), canonical_width, canonical_height)
        if moved[2] <= moved[0] or moved[3] <= moved[1]:
            continue
        detections.append(
            Detection(label_id=det.label_id, category=det.category, score=det.score, bbox_xyxy=(moved[0], moved[1], moved[2], moved[3]))
        )
    for item in result.unsupported:
        if item.bbox_xyxy is None:
            unsupported.append(item)
            continue
        moved = clamp_bbox(apply_matrix(transform_to_canonical, item.bbox_xyxy), canonical_width, canonical_height)
        if moved[2] <= moved[0] or moved[3] <= moved[1]:
            continue
        unsupported.append(
            UnsupportedDetection(
                category=item.category,
                detector_index=item.detector_index,
                score=item.score,
                bbox_xyxy=(moved[0], moved[1], moved[2], moved[3]),
            )
        )
    return DecodeResult(detections=tuple(detections), unsupported=tuple(unsupported), stats=result.stats)


def _bounded_id(base: str, suffix: str) -> str:
    candidate = f"{base}{suffix}"
    if len(candidate) <= 128:
        return candidate
    digest = hashlib.sha256(candidate.encode("utf-8")).hexdigest()[:32]
    return f"{base[:64]}#{digest}"


def _bbox_geometry(bbox) -> dict:
    return {
        "type": "bbox_xyxy",
        "x_min": bbox[0],
        "y_min": bbox[1],
        "x_max": bbox[2],
        "y_max": bbox[3],
    }


def build_candidate_raw(result, *, run_id):
    """Assemble the raw candidate payload for the candidate layer. This is the
    ONLY output channel of the detector: it never writes AnnotationRevision or
    any document state (contracts C4 — candidates go through submit_candidates)."""
    if not isinstance(run_id, str) or run_id == "" or len(run_id) > 128:
        raise DetectorError("invalid_run_id", "run_id must be a non-empty string of at most 128 characters")
    changes = []
    for index, det in enumerate(result.detections):
        changes.append(
            {
                "kind": "create",
                "change_id": _bounded_id(run_id, f"#c{index}"),
                "object": {
                    "object_id": _bounded_id(run_id, f"#o{index}"),
                    "label_id": det.label_id,
                    "geometry": _bbox_geometry(det.bbox_xyxy),
                    "attributes": {},
                    "origin": {"type": "prediction", "prediction_id": None, "model_run_id": None, "import_batch_id": None},
                },
                "before_hash": None,
                "reason": f"detector category {det.category!r} score {det.score:.4f}",
            }
        )
    issues = []
    for index, item in enumerate(result.unsupported):
        if item.category is None:
            message = f"detector class index {item.detector_index} has no known category and no explicit project label mapping"
        else:
            message = f"detector category {item.category!r} has no explicit project label mapping"
        issues.append(
            {
                "issue_id": _bounded_id(run_id, f"#u{index}"),
                "object_id": None,
                "code": "unsupported_category",
                "message": message,
                "region": _bbox_geometry(item.bbox_xyxy) if item.bbox_xyxy is not None else None,
            }
        )
    score = max((det.score for det in result.detections), default=None)
    return {"changes": changes, "issues": issues, "score": score}


# ---------------------------------------------------------------------------
# Real inference over the pinned weights (T32's execution gate)
# ---------------------------------------------------------------------------


class Predictor:
    """Real RT-DETR v2 inference over the pinned, hash-verified weights.

    Loading is strictly offline (``local_files_only=True``) and refuses to
    proceed unless every pinned file matches its sha256. Executing this path
    requires the user-authorized weights download plus the torch/transformers
    runtime; that execution is T32's gate and is not exercised by T18.
    """

    def __init__(self, *, processor, model, torch, lock):
        self._processor = processor
        self._model = model
        self._torch = torch
        self._lock = lock

    @classmethod
    def load(cls, lock_path, weights_dir, *, find_spec=None):
        lock = load_models_lock(lock_path)
        verify_weights(lock, Path(weights_dir))
        check_runtime(find_spec)
        import torch  # noqa: PLC0415 — lazy so the offline suite never needs it
        from transformers import AutoImageProcessor, AutoModelForObjectDetection  # noqa: PLC0415

        weights_dir = str(weights_dir)
        processor = AutoImageProcessor.from_pretrained(weights_dir, local_files_only=True)
        model = AutoModelForObjectDetection.from_pretrained(weights_dir, local_files_only=True)
        model.eval()
        return cls(processor=processor, model=model, torch=torch, lock=lock)

    def predict(self, image_path, *, label_mapping):
        from PIL import Image  # noqa: PLC0415 — comes with the real runtime

        from .transforms import LetterboxGeometry, ResizeGeometry  # noqa: PLC0415

        with open(image_path, "rb") as handle:
            image_bytes = handle.read()
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        original_width, original_height = image.size
        preprocessing = self._lock.get("preprocessing", {})
        mode = preprocessing.get("mode", "resize_stretch")
        input_width = int(preprocessing.get("input_width", 640))
        input_height = int(preprocessing.get("input_height", 640))
        if mode == "letterbox":
            geometry = LetterboxGeometry(
                width=original_width, height=original_height, target_width=input_width, target_height=input_height
            )
        else:
            geometry = ResizeGeometry(
                width=original_width, height=original_height, input_width=input_width, input_height=input_height
            )
        inputs = self._processor(images=image, return_tensors="pt")
        with self._torch.no_grad():
            outputs = self._model(**inputs)
        # Raw tensors cross into the single shared decoder via tolist(); no
        # second inverse scaling (target_sizes) is applied anywhere.
        raw_boxes = outputs.pred_boxes[0].tolist()
        raw_logits = outputs.pred_logits[0].tolist()
        postprocess = self._lock.get("postprocess", {})
        return decode_detections(
            raw_boxes=raw_boxes,
            raw_logits=raw_logits,
            id2label=self._model.config.id2label,
            geometry=geometry,
            label_mapping=label_mapping,
            score_threshold=float(postprocess.get("score_threshold", SCORE_THRESHOLD)),
            max_detections=min(int(postprocess.get("max_detections", MAX_DETECTIONS)), MAX_DETECTIONS),
        )
