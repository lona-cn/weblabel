"""T18: real CPU detector worker — coordinate inverse transforms, explicit label
mapping, bounded post-processing, and the worker protocol.

Evidence policy for this suite (hard constraint of the task card):
* Tests marked ``mock_tensor`` drive post-processing with synthetic mock
  tensors. They are post-processing evidence ONLY and never real inference
  evidence. Loading the pinned RT-DETR v2 weights and running them is T32's
  gate; nothing here claims it.
* No test downloads anything. models.lock.json pins the future authorized
  download; the offline suite verifies the pinning/verification code paths.
"""

from __future__ import annotations

import io
import json
import math
import os
import struct
import subprocess
import sys
import threading
import zlib
from pathlib import Path

import pytest

from weblabel_detector.labels import LabelMapping, LabelMappingError, unsupported_report
from weblabel_detector.model import (
    MAX_CLASSES,
    MAX_DETECTIONS,
    MAX_QUERIES,
    ConfigurationError,
    DecodeResult,
    DecodeStats,
    Detection,
    DetectorError,
    UnsupportedDetection,
    WeightsError,
    build_candidate_raw,
    check_runtime,
    compose_probe,
    decode_detections,
    load_models_lock,
    probe_status,
    project_detections,
    verify_weights,
)
from weblabel_detector.protocol import (
    MAX_LINE_BYTES,
    LineReader,
    ProtocolError,
    RequestIdTracker,
    parse_envelope,
    serialize_envelope,
)
from weblabel_detector.transforms import (
    LetterboxGeometry,
    ResizeGeometry,
    apply_matrix,
    clamp_bbox,
    forward_crop,
    forward_letterbox,
    forward_resize,
    inverse_crop,
    inverse_letterbox,
    inverse_resize,
    letterbox_params,
    resize_params,
)

# ---------------------------------------------------------------------------
# Canonical transform primitives (C1/C2/C8)
# ---------------------------------------------------------------------------


def test_inverse_letterbox_restores_canonical_box():
    # 原图640x480 -> scale=1 -> 补上下80，模型框y整体+80
    got = inverse_letterbox([10, 100, 110, 300], scale=1.0, pad_x=0.0, pad_y=80.0)
    assert got == [10, 20, 110, 220]


def test_letterbox_params_non_square_landscape_and_portrait():
    # 800x600 -> 640x640: scale 0.8, pad top/bottom 80 each (per side).
    assert letterbox_params(800, 600, 640, 640) == (pytest.approx(0.8), pytest.approx(0.0), pytest.approx(80.0))
    # 480x800 -> 640x640: scale 0.8, pad left/right 128 each (per side).
    assert letterbox_params(480, 800, 640, 640) == (pytest.approx(0.8), pytest.approx(128.0), pytest.approx(0.0))
    # Non-square target keeps both axes independent.
    scale, pad_x, pad_y = letterbox_params(1000, 500, 320, 160)
    assert (scale, pad_x, pad_y) == (pytest.approx(0.32), pytest.approx(0.0), pytest.approx(0.0))


def test_forward_letterbox_known_vectors():
    scale, pad_x, pad_y = letterbox_params(800, 600, 640, 640)
    assert forward_letterbox([0, 0, 800, 600], scale=scale, pad_x=pad_x, pad_y=pad_y) == [
        pytest.approx(0.0),
        pytest.approx(80.0),
        pytest.approx(640.0),
        pytest.approx(560.0),
    ]
    scale, pad_x, pad_y = letterbox_params(480, 800, 640, 640)
    assert forward_letterbox([0, 0, 480, 800], scale=scale, pad_x=pad_x, pad_y=pad_y) == [
        pytest.approx(128.0),
        pytest.approx(0.0),
        pytest.approx(512.0),
        pytest.approx(640.0),
    ]


@pytest.mark.parametrize(
    ("width", "height", "target_w", "target_h", "box"),
    [
        (800, 600, 640, 640, [10.0, 20.0, 110.0, 300.0]),
        (480, 800, 640, 640, [0.5, 0.25, 479.5, 799.75]),
        (1920, 1080, 640, 640, [100.0, 200.0, 1500.0, 900.0]),
        (640, 480, 640, 640, [10.0, 100.0, 110.0, 300.0]),
    ],
)
def test_letterbox_round_trip_error_bound_non_square(width, height, target_w, target_h, box):
    scale, pad_x, pad_y = letterbox_params(width, height, target_w, target_h)
    model_box = forward_letterbox(box, scale=scale, pad_x=pad_x, pad_y=pad_y)
    restored = inverse_letterbox(model_box, scale=scale, pad_x=pad_x, pad_y=pad_y)
    assert max(abs(a - b) for a, b in zip(restored, box)) <= 1e-9


def test_resize_forward_inverse_non_square_known_vector():
    scale_x, scale_y = resize_params(800, 600, 640, 640)
    assert scale_x == pytest.approx(0.8)
    assert scale_y == pytest.approx(640.0 / 600.0)
    got = forward_resize([10, 20, 110, 300], scale_x=scale_x, scale_y=scale_y)
    assert got == [pytest.approx(8.0), pytest.approx(20.0 * 640.0 / 600.0), pytest.approx(88.0), pytest.approx(320.0)]
    restored = inverse_resize(got, scale_x=scale_x, scale_y=scale_y)
    assert max(abs(a - b) for a, b in zip(restored, [10, 20, 110, 300])) <= 1e-9


def test_resize_round_trip_error_bound_non_square():
    for width, height, target_w, target_h, box in [
        (3000, 2000, 640, 640, [1.0, 2.0, 2999.0, 1999.0]),
        (333, 777, 641, 640, [0.0, 0.0, 333.0, 777.0]),
        (640, 480, 640, 640, [10.0, 20.0, 110.0, 300.0]),
    ]:
        scale_x, scale_y = resize_params(width, height, target_w, target_h)
        restored = inverse_resize(forward_resize(box, scale_x=scale_x, scale_y=scale_y), scale_x=scale_x, scale_y=scale_y)
        assert max(abs(a - b) for a, b in zip(restored, box)) <= 1e-9


def test_crop_forward_inverse_known_vector():
    box = [10.0, 20.0, 110.0, 300.0]
    cropped = forward_crop(box, left=8.0, top=16.0)
    assert cropped == [pytest.approx(2.0), pytest.approx(4.0), pytest.approx(102.0), pytest.approx(284.0)]
    assert inverse_crop(cropped, left=8.0, top=16.0) == [pytest.approx(v) for v in box]


def test_apply_matrix_translation_and_scale_exact():
    box = [10.0, 20.0, 110.0, 220.0]
    translate = [1.0, 0.0, 5.0, 0.0, 1.0, 7.0, 0.0, 0.0, 1.0]
    assert apply_matrix(translate, box) == [pytest.approx(15.0), pytest.approx(27.0), pytest.approx(115.0), pytest.approx(227.0)]
    scale = [2.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 1.0]
    assert apply_matrix(scale, box) == [pytest.approx(20.0), pytest.approx(40.0), pytest.approx(220.0), pytest.approx(440.0)]


def test_apply_matrix_axis_swap_takes_corner_aabb():
    # 90° rotation about the origin: (x, y) -> (-y, x).
    rotate = [0.0, -1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]
    got = apply_matrix(rotate, [0.0, 0.0, 2.0, 1.0])
    assert got == [pytest.approx(-1.0), pytest.approx(0.0), pytest.approx(0.0), pytest.approx(2.0)]


def test_apply_matrix_rejects_non_finite_or_wrong_shape():
    with pytest.raises(DetectorError) as err:
        apply_matrix([1.0, 0.0, 0.0, 0.0, 1.0, 0.0], [0, 0, 1, 1])
    assert err.value.code == "invalid_matrix"
    with pytest.raises(DetectorError) as err:
        apply_matrix([1.0, 0.0, float("nan"), 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], [0, 0, 1, 1])
    assert err.value.code == "invalid_matrix"


def test_clamp_bbox_legal_boundaries():
    assert clamp_bbox([-5.0, -5.0, 650.0, 490.0], 640, 480) == [0.0, 0.0, 640.0, 480.0]
    assert clamp_bbox([700.0, 200.0, 900.0, 300.0], 640, 480) == [640.0, 200.0, 640.0, 300.0]
    assert clamp_bbox([10.0, 20.0, 30.0, 40.0], 640, 480) == [10.0, 20.0, 30.0, 40.0]


# ---------------------------------------------------------------------------
# Explicit label mapping (no COCO-index / no name guessing)
# ---------------------------------------------------------------------------


def test_explicit_mapping_only_and_unmapped_is_reported():
    mapping = LabelMapping.from_raw({"person": "label_person"})
    assert mapping.map_category("person") == "label_person"
    assert mapping.map_category("zebra") is None
    report = unsupported_report("zebra", 22, 0.9)
    assert report == {"code": "unsupported_category", "category": "zebra", "detector_index": 22, "score": pytest.approx(0.9)}


def test_mapping_validation_rejects_bad_shapes():
    with pytest.raises(LabelMappingError) as err:
        LabelMapping.from_raw(["person"])
    assert err.value.code == "invalid_mapping"
    with pytest.raises(LabelMappingError) as err:
        LabelMapping.from_raw({5: "label_person"})
    assert err.value.code == "invalid_mapping"
    with pytest.raises(LabelMappingError) as err:
        LabelMapping.from_raw({"person": 7})
    assert err.value.code == "invalid_mapping"
    with pytest.raises(LabelMappingError) as err:
        LabelMapping.from_raw({"": "label_person"})
    assert err.value.code == "invalid_mapping"
    with pytest.raises(LabelMappingError) as err:
        LabelMapping.from_raw({"x" * 129: "label_person"})
    assert err.value.code == "invalid_mapping"
    with pytest.raises(LabelMappingError) as err:
        LabelMapping.from_raw({"person": "y" * 129})
    assert err.value.code == "invalid_mapping"
    with pytest.raises(LabelMappingError) as err:
        LabelMapping.from_raw({f"c{i}": f"label_{i}" for i in range(4097)})
    assert err.value.code == "too_many_entries"


def test_mapping_rejects_label_ids_outside_the_ontology():
    with pytest.raises(LabelMappingError) as err:
        LabelMapping.from_raw({"person": "label_missing"}, valid_label_ids={"label_person"})
    assert err.value.code == "unknown_label_id"
    ok = LabelMapping.from_raw({"person": "label_person"}, valid_label_ids={"label_person"})
    assert ok.map_category("person") == "label_person"


# ---------------------------------------------------------------------------
# Post-processing on synthetic MOCK TENSORS — post-processing evidence only.
# Real tensor/weight execution is T32's gate and is NOT claimed here.
# ---------------------------------------------------------------------------


def _identity_geometry():
    return ResizeGeometry(width=640, height=480, input_width=640, input_height=480)


@pytest.mark.mock_tensor
def test_mock_decode_known_vector_resize_geometry():
    geometry = ResizeGeometry(width=800, height=600, input_width=640, input_height=640)
    mapping = LabelMapping.from_raw({"person": "label_person"}, valid_label_ids={"label_person"})
    # One query: normalized cxcywh box (0.5, 0.5, 0.5, 0.5); logits [person, zebra].
    result = decode_detections(
        raw_boxes=[[0.5, 0.5, 0.5, 0.5]],
        raw_logits=[[2.0, -5.0]],
        id2label={0: "person", 1: "zebra"},
        geometry=geometry,
        label_mapping=mapping,
    )
    assert len(result.detections) == 1
    det = result.detections[0]
    assert det.label_id == "label_person"
    assert det.category == "person"
    assert det.bbox_xyxy == (
        pytest.approx(200.0, abs=1e-9),
        pytest.approx(150.0, abs=1e-9),
        pytest.approx(600.0, abs=1e-9),
        pytest.approx(450.0, abs=1e-9),
    )
    assert det.score == pytest.approx(1.0 / (1.0 + math.exp(-2.0)), abs=1e-12)
    assert result.unsupported == ()
    assert result.stats.queries == 1


@pytest.mark.mock_tensor
def test_mock_decode_letterbox_chain_matches_golden_vector():
    # 原图640x480 -> scale=1 -> 补上下80 -> 模型框 [10,100,110,300] 必须反变换回 [10,20,110,220]。
    geometry = LetterboxGeometry(width=640, height=480, target_width=640, target_height=640)
    mapping = LabelMapping.from_raw({"person": "label_person"}, valid_label_ids={"label_person"})
    model_box_xyxy = [10.0, 100.0, 110.0, 300.0]  # model-input pixels
    cx = (model_box_xyxy[0] + model_box_xyxy[2]) / 2.0 / 640.0
    cy = (model_box_xyxy[1] + model_box_xyxy[3]) / 2.0 / 640.0
    w = (model_box_xyxy[2] - model_box_xyxy[0]) / 640.0
    h = (model_box_xyxy[3] - model_box_xyxy[1]) / 640.0
    result = decode_detections(
        raw_boxes=[[cx, cy, w, h]],
        raw_logits=[[3.0, -3.0]],
        id2label={0: "person", 1: "zebra"},
        geometry=geometry,
        label_mapping=mapping,
    )
    assert len(result.detections) == 1
    det = result.detections[0]
    assert det.bbox_xyxy == (pytest.approx(10.0, abs=1e-9), pytest.approx(20.0, abs=1e-9), pytest.approx(110.0, abs=1e-9), pytest.approx(220.0, abs=1e-9))


@pytest.mark.mock_tensor
def test_mock_decode_threshold_and_topk_are_bounded():
    geometry = _identity_geometry()
    mapping = LabelMapping.from_raw({"person": "label_person"}, valid_label_ids={"label_person"})
    boxes = [[0.5, 0.5, 0.2, 0.2]] * 5
    logits = [[8.0], [7.0], [1.0], [-4.0], [-9.0]]  # sigmoid: 4 above 0.5, then threshold + cap
    result = decode_detections(
        raw_boxes=boxes,
        raw_logits=logits,
        id2label={0: "person"},
        geometry=geometry,
        label_mapping=mapping,
        score_threshold=0.5,
        max_detections=2,
    )
    # sigmoid(8) and sigmoid(7) survive the cap; sigmoid(1)=0.731 is above the
    # threshold but truncated by max_detections=2; the two negatives are below.
    assert result.detections[0].score == pytest.approx(1.0 / (1.0 + math.exp(-8.0)), abs=1e-12)
    assert result.detections[1].score == pytest.approx(1.0 / (1.0 + math.exp(-7.0)), abs=1e-12)
    assert result.stats.dropped_below_threshold == 2
    assert result.stats.truncated_to_max == 1
    assert len(result.detections) == 2


@pytest.mark.mock_tensor
def test_mock_decode_drops_non_finite_queries_and_never_emits_non_finite():
    geometry = _identity_geometry()
    mapping = LabelMapping.from_raw({"person": "label_person"}, valid_label_ids={"label_person"})
    result = decode_detections(
        raw_boxes=[[0.5, 0.5, 0.2, 0.2], [0.5, 0.5, 0.2, 0.2], [0.5, 0.5, float("inf"), 0.2]],
        raw_logits=[[3.0], [float("nan")], [3.0]],
        id2label={0: "person"},
        geometry=geometry,
        label_mapping=mapping,
    )
    assert result.stats.dropped_non_finite == 2
    assert len(result.detections) == 1
    for det in result.detections:
        assert math.isfinite(det.score)
        assert all(math.isfinite(v) for v in det.bbox_xyxy)
    for item in result.unsupported:
        assert math.isfinite(item.score)


@pytest.mark.mock_tensor
def test_mock_decode_clamps_to_legal_bounds_and_drops_degenerate():
    geometry = _identity_geometry()  # 640x480
    mapping = LabelMapping.from_raw({"person": "label_person"}, valid_label_ids={"label_person"})
    result = decode_detections(
        raw_boxes=[[0.5, 0.5, 2.0, 2.0], [2.5, 0.5, 0.2, 0.2]],
        raw_logits=[[3.0], [3.0]],
        id2label={0: "person"},
        geometry=geometry,
        label_mapping=mapping,
    )
    assert len(result.detections) == 1
    det = result.detections[0]
    assert det.bbox_xyxy == (0.0, 0.0, 640.0, 480.0)  # clamped, exact legal bounds
    assert result.stats.dropped_degenerate == 1  # the out-of-frame query clamps to zero area


@pytest.mark.mock_tensor
def test_mock_decode_empty_result_is_empty_not_negative():
    geometry = _identity_geometry()
    mapping = LabelMapping.from_raw({}, valid_label_ids=set())
    result = decode_detections(
        raw_boxes=[[0.5, 0.5, 0.2, 0.2]],
        raw_logits=[[-9.0]],
        id2label={0: "person"},
        geometry=geometry,
        label_mapping=mapping,
    )
    assert result.detections == ()
    assert result.unsupported == ()
    assert result.stats.dropped_below_threshold == 1
    assert result.stats.queries == 1


@pytest.mark.mock_tensor
def test_mock_decode_unmapped_category_is_reported_and_never_guessed():
    geometry = _identity_geometry()
    # Only "zebra" is explicitly mapped. Query argmax is class 0 = "person".
    mapping = LabelMapping.from_raw({"zebra": "label_zebra"}, valid_label_ids={"label_zebra"})
    result = decode_detections(
        raw_boxes=[[0.5, 0.5, 0.2, 0.2], [0.3, 0.3, 0.1, 0.1]],
        raw_logits=[[3.0, -3.0], [-3.0, 3.0]],
        id2label={0: "person", 1: "zebra"},
        geometry=geometry,
        label_mapping=mapping,
    )
    # The person detection must NOT be guessed into any project label.
    assert all(d.category == "zebra" and d.label_id == "label_zebra" for d in result.detections)
    assert len(result.detections) == 1
    assert len(result.unsupported) == 1
    report = result.unsupported[0]
    assert report.category == "person"
    assert report.detector_index == 0
    assert report.score == pytest.approx(1.0 / (1.0 + math.exp(-3.0)), abs=1e-12)


@pytest.mark.mock_tensor
def test_mock_decode_reports_unknown_class_index_without_guessing():
    geometry = _identity_geometry()
    mapping = LabelMapping.from_raw({"person": "label_person"}, valid_label_ids={"label_person"})
    result = decode_detections(
        raw_boxes=[[0.5, 0.5, 0.2, 0.2]],
        raw_logits=[[3.0]],
        id2label={},  # class index 0 has no known category at all
        geometry=geometry,
        label_mapping=mapping,
    )
    assert result.detections == ()
    assert len(result.unsupported) == 1
    assert result.unsupported[0].category is None
    assert result.unsupported[0].detector_index == 0


@pytest.mark.mock_tensor
def test_mock_decode_enforces_cpu_memory_budget_bounds():
    geometry = _identity_geometry()
    mapping = LabelMapping.from_raw({}, valid_label_ids=set())
    with pytest.raises(DetectorError) as err:
        decode_detections(
            raw_boxes=[[0.5, 0.5, 0.2, 0.2]] * (MAX_QUERIES + 1),
            raw_logits=[[1.0]] * (MAX_QUERIES + 1),
            id2label={0: "person"},
            geometry=geometry,
            label_mapping=mapping,
        )
    assert err.value.code == "input_too_large"
    with pytest.raises(DetectorError) as err:
        decode_detections(
            raw_boxes=[[0.5, 0.5, 0.2, 0.2]],
            raw_logits=[[1.0] * (MAX_CLASSES + 1)],
            id2label={0: "person"},
            geometry=geometry,
            label_mapping=mapping,
        )
    assert err.value.code == "input_too_large"
    with pytest.raises(DetectorError) as err:
        decode_detections(
            raw_boxes=[[0.5, 0.5, 0.2]],
            raw_logits=[[1.0]],
            id2label={0: "person"},
            geometry=geometry,
            label_mapping=mapping,
        )
    assert err.value.code == "invalid_input"
    with pytest.raises(DetectorError) as err:
        decode_detections(
            raw_boxes=[[0.5, 0.5, 0.2, 0.2]],
            raw_logits=[[1.0]],
            id2label={0: "person"},
            geometry=geometry,
            label_mapping=mapping,
            max_detections=MAX_DETECTIONS + 1,
        )
    assert err.value.code == "invalid_max_detections"


# ---------------------------------------------------------------------------
# Candidate assembly: candidates only, never AnnotationRevision writes.
# ---------------------------------------------------------------------------


def _decode_result_for_assembly() -> DecodeResult:
    return DecodeResult(
        detections=(
            Detection(label_id="label_person", category="person", score=0.75, bbox_xyxy=(15.0, 27.0, 115.0, 227.0)),
        ),
        unsupported=(UnsupportedDetection(category="zebra", detector_index=22, score=0.9, bbox_xyxy=(15.0, 27.0, 115.0, 227.0)),),
        stats=DecodeStats(queries=2, dropped_non_finite=0, dropped_below_threshold=0, dropped_degenerate=0, truncated_to_max=0),
    )


def test_build_candidate_raw_is_candidate_layer_only():
    raw = build_candidate_raw(_decode_result_for_assembly(), run_id="run-1")
    assert set(raw.keys()) == {"changes", "issues", "score"}  # no document/revision payload can leak through
    assert raw["score"] == pytest.approx(0.75)
    change = raw["changes"][0]
    assert change["kind"] == "create"
    assert change["before_hash"] is None
    obj = change["object"]
    assert obj["label_id"] == "label_person"
    assert obj["geometry"] == {
        "type": "bbox_xyxy",
        "x_min": pytest.approx(15.0),
        "y_min": pytest.approx(27.0),
        "x_max": pytest.approx(115.0),
        "y_max": pytest.approx(227.0),
    }
    assert obj["attributes"] == {}
    assert obj["origin"] == {"type": "prediction", "prediction_id": None, "model_run_id": None, "import_batch_id": None}
    issue = raw["issues"][0]
    assert issue["code"] == "unsupported_category"
    assert issue["object_id"] is None
    assert issue["region"] == {
        "type": "bbox_xyxy",
        "x_min": pytest.approx(15.0),
        "y_min": pytest.approx(27.0),
        "x_max": pytest.approx(115.0),
        "y_max": pytest.approx(227.0),
    }
    assert all(len(change["change_id"]) <= 128 for change in raw["changes"])
    assert all(len(issue["issue_id"]) <= 128 for issue in raw["issues"])


def test_project_detections_applies_canonical_matrix_and_clamps():
    result = _decode_result_for_assembly()
    translate = [1.0, 0.0, 5.0, 0.0, 1.0, 7.0, 0.0, 0.0, 1.0]
    projected = project_detections(result, transform_to_canonical=translate, canonical_width=120, canonical_height=220)
    det = projected.detections[0]
    assert det.bbox_xyxy == (pytest.approx(20.0), pytest.approx(34.0), pytest.approx(120.0), pytest.approx(220.0))
    assert projected.unsupported[0].bbox_xyxy == det.bbox_xyxy
    # A matrix that squeezes the box to zero area drops it instead of emitting invalid geometry.
    squash = [0.0, 0.0, 10.0, 0.0, 0.0, 10.0, 0.0, 0.0, 1.0]
    squeezed = project_detections(result, transform_to_canonical=squash, canonical_width=1000, canonical_height=1000)
    assert squeezed.detections == ()


# ---------------------------------------------------------------------------
# models.lock.json pinning: hash verification, runtime probe, probe policy.
# ---------------------------------------------------------------------------


REAL_LOCK_PATH = Path(__file__).resolve().parents[1] / "models.lock.json"


def _write_test_lock(directory: Path, files: dict[str, bytes]) -> Path:
    entries = []
    for name, data in files.items():
        entries.append(
            {
                "path": name,
                "role": "weights" if name.endswith(".safetensors") else "model_config",
                "bytes": len(data),
                "sha256": __import__("hashlib").sha256(data).hexdigest(),
            }
        )
    lock = {"schema_version": 1, "model_id": "test/model@0000", "files": entries}
    path = directory / "models.lock.json"
    path.write_text(json.dumps(lock), encoding="utf-8")
    return path


def test_real_models_lock_pins_exact_revision_hash_and_license_without_downloading():
    lock = load_models_lock(REAL_LOCK_PATH)
    assert lock["source"]["revision"] == "5650961749fa93567c0d46fc7f43ea4f9e914107"
    assert lock["license"]["id"] == "apache-2.0"
    assert lock["download"]["weights_downloaded"] is False
    by_role = {entry["role"]: entry for entry in lock["files"]}
    assert by_role["weights"]["path"] == "model.safetensors"
    assert by_role["weights"]["bytes"] == 80904640
    assert by_role["weights"]["sha256"] == "d18309d0d7ea57048138885c4c6ecfcb1e24506fc6153b94ad484f8ab62c7115"
    assert len(by_role["weights"]["sha256"]) == 64
    assert lock["preprocessing"]["mode"] == "resize_stretch"


def test_verify_weights_missing_is_needs_configuration(tmp_path):
    lock_path = _write_test_lock(tmp_path, {"model.safetensors": b"fake-weights"})
    # The pinned file itself is absent from the weights directory.
    with pytest.raises(ConfigurationError) as err:
        verify_weights(load_models_lock(lock_path), tmp_path)
    assert err.value.code == "needs_configuration"
    assert "model.safetensors" in err.value.message


def test_verify_weights_accepts_matching_and_rejects_tampered_files(tmp_path):
    data = b"synthetic-weights-not-real-model-bytes"
    lock_path = _write_test_lock(tmp_path, {"model.safetensors": data})
    (tmp_path / "model.safetensors").write_bytes(data)
    lock = load_models_lock(lock_path)
    assert verify_weights(lock, tmp_path) is None  # matching hashes verify
    (tmp_path / "model.safetensors").write_bytes(data + b"X")  # tamper one byte
    with pytest.raises(WeightsError) as err:
        verify_weights(lock, tmp_path)
    assert err.value.code == "weights_hash_mismatch"


def test_check_runtime_reports_missing_real_inference_stack():
    with pytest.raises(ConfigurationError) as err:
        check_runtime(find_spec=lambda name: None)
    assert err.value.code == "needs_configuration"
    assert "torch" in err.value.message and "transformers" in err.value.message
    assert check_runtime(find_spec=lambda name: object()) is None


def test_probe_policy_composition_reports_both_dimensions_honestly():
    model_id = "PekingU/rtdetr_v2_r18vd@5650961749fa93567c0d46fc7f43ea4f9e914107"
    missing = compose_probe(model_id, weights_ok=False, weights_error="weights missing", missing_runtime=("torch",))
    assert missing["provider_id"] == "detector_local"
    assert missing["model_id"] == model_id
    assert missing["auth_kind"] == "local_weights"
    assert missing["availability"] == "needs_configuration"
    assert missing["verification"] == "not_run"  # no mock/live claim is ever possible from T18
    assert missing["capabilities"] == {
        "image_input": True,
        "tools": False,
        "structured_output": True,
        "bbox_output": True,
        "attributes": False,
    }
    missing_runtime_only = compose_probe(model_id, weights_ok=True, weights_error=None, missing_runtime=("torch",))
    assert missing_runtime_only["availability"] == "needs_configuration"
    ready = compose_probe(model_id, weights_ok=True, weights_error=None, missing_runtime=())
    assert ready["availability"] == "ready"
    assert ready["verification"] == "not_run"
    assert ready["runtime_version"] is not None
    assert ready["verified_at"] is None


def test_probe_status_with_empty_weights_dir_reports_missing(tmp_path):
    lock_path = _write_test_lock(tmp_path, {"model.safetensors": b"fake"})
    status = probe_status(lock_path, tmp_path / "weights", find_spec=lambda name: None)
    assert status.weights_ok is False
    assert "model.safetensors" in (status.weights_error or "")
    assert status.missing_runtime == ("torch", "transformers")


# ---------------------------------------------------------------------------
# Worker: single-concurrency batch processing, cancellation of waiting items,
# bounded queue, real failure paths. The scheduling double produces NO model
# output; it only makes scheduling observable. No inference is claimed.
# ---------------------------------------------------------------------------


def _png_bytes(width: int = 4, height: int = 4) -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    raw = b"".join(b"\x00" + b"\x00" * (width * 4) for _ in range(height))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


class SchedulingDouble:
    """Scheduling test double. Returns fixed DecodeResults and records call
    order/concurrency. It produces no model inference and is not evidence of
    model behavior."""

    def __init__(self, results: list[DecodeResult] | None = None, block_first: bool = False):
        self.results = list(results or [])
        self.calls: list[str] = []
        self.max_active = 0
        self._active = 0
        self._lock = threading.Lock()
        self.started = threading.Event()
        self.release = threading.Event()
        self._block_first = block_first
        self._blocked_once = False
        if not block_first:
            self.release.set()

    def __call__(self):
        return self

    def predict(self, image_path, *, label_mapping):
        with self._lock:
            self.calls.append(image_path)
            self._active += 1
            self.max_active = max(self.max_active, self._active)
            block = self._block_first and not self._blocked_once
            if block:
                self._blocked_once = True
        self.started.set()
        try:
            if block:
                assert self.release.wait(timeout=20), "test double was never released"
        finally:
            with self._lock:
                self._active -= 1
        index = len(self.calls) - 1
        if index < len(self.results):
            return self.results[index]
        return DecodeResult(
            detections=(),
            unsupported=(),
            stats=DecodeStats(queries=0, dropped_non_finite=0, dropped_below_threshold=0, dropped_degenerate=0, truncated_to_max=0),
        )


class LineSink:
    def __init__(self):
        self._lines: list[str] = []
        self._lock = threading.Lock()

    def write(self, text: str) -> int:
        with self._lock:
            self._lines.append(text)
        return len(text)

    def lines(self) -> list[str]:
        with self._lock:
            snapshot = list(self._lines)
        return [line for chunk in snapshot for line in chunk.splitlines() if line]


def _make_worker(tmp_path, double=None, max_pending=8, weights_files=None, weights_dir=None):
    from weblabel_detector.__main__ import Worker

    lock_path = _write_test_lock(tmp_path, weights_files if weights_files is not None else {"model.safetensors": b"fake"})
    image_path = tmp_path / "input.png"
    image_path.write_bytes(_png_bytes())
    out = LineSink()
    worker = Worker(
        lock_path=lock_path,
        weights_dir=weights_dir or tmp_path,
        out=out,
        predictor_factory=double,  # None -> the real Predictor.load path
        max_pending=max_pending,
        find_spec=lambda name: None,
    )
    return worker, out, str(image_path)


def _start_run_line(image_path, run_id, *, intent="detect", label_mapping=None, ontology_label_ids=("label_person",)):
    payload = {
        "run_id": run_id,
        "request": {"intent": intent},
        "image": {"path": image_path, "transform_to_canonical": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]},
        "label_mapping": {"person": "label_person"} if label_mapping is None else label_mapping,
        "ontology_label_ids": list(ontology_label_ids),
        "canonical_size": {"width": 640, "height": 480},
    }
    return serialize_envelope(
        {"protocol_version": 1, "id": run_id, "kind": "request", "method": "start_run", "payload": payload}
    )


def _events(out: LineSink) -> list[dict]:
    found = []
    for line in out.lines():
        env = json.loads(line)
        if env["kind"] == "event":
            found.append(env["payload"])
    return found


def _responses(out: LineSink) -> list[dict]:
    found = []
    for line in out.lines():
        env = json.loads(line)
        if env["kind"] == "response":
            found.append({"method": env["method"], **env["payload"]})
    return found


def test_worker_processes_batch_one_by_one_with_single_concurrency(tmp_path):
    double = SchedulingDouble(block_first=True)
    worker, out, image_path = _make_worker(tmp_path, double=double)
    worker.start()
    worker.handle_line(_start_run_line(image_path, "run-a"))
    assert double.started.wait(timeout=10)
    worker.handle_line(_start_run_line(image_path, "run-b"))
    worker.handle_line(_start_run_line(image_path, "run-c"))
    # While run-a is in flight nothing else may be processed.
    assert double.calls == [image_path]
    double.release.set()
    worker.wait_idle(timeout=20)
    worker.shutdown()
    assert double.calls == [image_path, image_path, image_path]
    assert double.max_active == 1  # single worker, concurrency 1
    statuses = {resp["run_id"]: resp["status"] for resp in _responses(out) if resp["method"] == "start_run"}
    assert statuses == {"run-a": "succeeded", "run-b": "succeeded", "run-c": "succeeded"}
    for run_id in ("run-a", "run-b", "run-c"):
        kinds = [event["type"] for event in _events(out) if event["run_id"] == run_id]
        assert kinds == ["queued", "started", "succeeded"]


def test_worker_cancel_waiting_item_never_processes_it(tmp_path):
    double = SchedulingDouble(block_first=True)
    worker, out, image_path = _make_worker(tmp_path, double=double)
    worker.start()
    worker.handle_line(_start_run_line(image_path, "run-a"))
    assert double.started.wait(timeout=10)
    worker.handle_line(_start_run_line(image_path, "run-b"))
    worker.handle_line(serialize_envelope({"protocol_version": 1, "id": "cancel-1", "kind": "request", "method": "cancel_run", "payload": {"run_id": "run-b"}}))
    cancel_responses = [resp for resp in _responses(out) if resp["method"] == "cancel_run"]
    assert cancel_responses == [{"method": "cancel_run", "ok": True, "run_id": "run-b", "status": "cancelled"}]
    run_b_responses = [resp for resp in _responses(out) if resp.get("run_id") == "run-b" and resp["method"] == "start_run"]
    assert run_b_responses and run_b_responses[0]["status"] == "cancelled"  # every request still gets a terminal response
    double.release.set()
    worker.wait_idle(timeout=20)
    worker.shutdown()
    assert double.calls == [image_path]  # run-b was never processed
    kinds_b = [event["type"] for event in _events(out) if event["run_id"] == "run-b"]
    assert kinds_b == ["queued", "cancelled"]
    kinds_a = [event["type"] for event in _events(out) if event["run_id"] == "run-a"]
    assert kinds_a == ["queued", "started", "succeeded"]


def test_worker_queue_is_bounded_and_rejects_beyond_budget(tmp_path):
    double = SchedulingDouble(block_first=True)
    worker, out, image_path = _make_worker(tmp_path, double=double, max_pending=2)
    worker.start()
    worker.handle_line(_start_run_line(image_path, "run-a"))
    assert double.started.wait(timeout=10)
    worker.handle_line(_start_run_line(image_path, "run-b"))
    worker.handle_line(_start_run_line(image_path, "run-c"))
    worker.handle_line(_start_run_line(image_path, "run-d"))
    rejected = [resp for resp in _responses(out) if resp.get("run_id") == "run-d"]
    assert rejected and rejected[0]["ok"] is False and rejected[0]["error"]["code"] == "queue_full"
    assert "run-d" not in [event["run_id"] for event in _events(out)]
    double.release.set()
    worker.wait_idle(timeout=20)
    worker.shutdown()
    assert double.calls == [image_path, image_path, image_path]


def test_worker_run_without_weights_fails_needs_configuration_and_keeps_serving(tmp_path):
    # Real predictor path with no downloaded weights: the run must fail with
    # needs_configuration and must never fabricate candidates.
    worker, out, image_path = _make_worker(tmp_path, weights_dir=tmp_path / "weights")
    worker.start()
    worker.handle_line(_start_run_line(image_path, "run-real"))
    worker.wait_idle(timeout=20)
    run_responses = [resp for resp in _responses(out) if resp["method"] == "start_run"]
    assert run_responses[0]["ok"] is False
    assert run_responses[0]["status"] == "failed"
    assert run_responses[0]["error"]["code"] == "needs_configuration"
    kinds = [event["type"] for event in _events(out) if event["run_id"] == "run-real"]
    assert kinds == ["queued", "started", "failed"]
    assert not [event for event in _events(out) if event["type"] == "candidate"]
    # The worker keeps serving afterwards (an unconfigured detector never
    # breaks the workbench; manual editing has nothing to do with this service).
    worker.handle_line(serialize_envelope({"protocol_version": 1, "id": "probe-1", "kind": "request", "method": "probe", "payload": {}}))
    probe_responses = [resp for resp in _responses(out) if resp["method"] == "probe"]
    assert probe_responses and probe_responses[0]["ok"] is True
    worker.shutdown()


def test_worker_cancel_in_flight_run_drops_candidate_at_stage_boundary(tmp_path):
    result = DecodeResult(
        detections=(Detection(label_id="label_person", category="person", score=0.5, bbox_xyxy=(1.0, 2.0, 3.0, 4.0)),),
        unsupported=(),
        stats=DecodeStats(queries=1, dropped_non_finite=0, dropped_below_threshold=0, dropped_degenerate=0, truncated_to_max=0),
    )
    double = SchedulingDouble(results=[result], block_first=True)
    worker, out, image_path = _make_worker(tmp_path, double=double)
    worker.start()
    worker.handle_line(_start_run_line(image_path, "run-a"))
    assert double.started.wait(timeout=10)
    worker.handle_line(serialize_envelope({"protocol_version": 1, "id": "cancel-a", "kind": "request", "method": "cancel_run", "payload": {"run_id": "run-a"}}))
    double.release.set()
    worker.wait_idle(timeout=20)
    worker.shutdown()
    kinds = [event["type"] for event in _events(out) if event["run_id"] == "run-a"]
    assert kinds == ["queued", "started", "cancelled"]  # a cancelled run never emits candidates
    run_responses = [resp for resp in _responses(out) if resp.get("run_id") == "run-a" and resp["method"] == "start_run"]
    assert run_responses and run_responses[0]["status"] == "cancelled"


def test_worker_empty_detection_result_succeeds_without_candidate(tmp_path):
    double = SchedulingDouble()
    worker, out, image_path = _make_worker(tmp_path, double=double)
    worker.start()
    worker.handle_line(_start_run_line(image_path, "run-empty"))
    worker.wait_idle(timeout=20)
    worker.shutdown()
    kinds = [event["type"] for event in _events(out) if event["run_id"] == "run-empty"]
    assert kinds == ["queued", "started", "succeeded"]  # empty result is success, not negative, not failure
    assert not [event for event in _events(out) if event["type"] == "candidate"]


def test_worker_maps_canonical_transform_and_submits_candidate_events(tmp_path):
    result = DecodeResult(
        detections=(Detection(label_id="label_person", category="person", score=0.75, bbox_xyxy=(10.0, 20.0, 110.0, 220.0)),),
        unsupported=(),
        stats=DecodeStats(queries=1, dropped_non_finite=0, dropped_below_threshold=0, dropped_degenerate=0, truncated_to_max=0),
    )
    double = SchedulingDouble(results=[result])
    worker, out, image_path = _make_worker(tmp_path, double=double)
    worker.start()
    line = serialize_envelope(
        {
            "protocol_version": 1,
            "id": "run-1",
            "kind": "request",
            "method": "start_run",
            "payload": {
                "run_id": "run-1",
                "request": {"intent": "detect"},
                "image": {"path": image_path, "transform_to_canonical": [1.0, 0.0, 5.0, 0.0, 1.0, 7.0, 0.0, 0.0, 1.0]},
                "label_mapping": {"person": "label_person"},
                "ontology_label_ids": ["label_person"],
                "canonical_size": {"width": 640, "height": 480},
            },
        }
    )
    worker.handle_line(line)
    worker.wait_idle(timeout=20)
    worker.shutdown()
    candidates = [event["data"]["raw"] for event in _events(out) if event["type"] == "candidate"]
    assert len(candidates) == 1
    geometry = candidates[0]["changes"][0]["object"]["geometry"]
    assert geometry == {
        "type": "bbox_xyxy",
        "x_min": pytest.approx(15.0),
        "y_min": pytest.approx(27.0),
        "x_max": pytest.approx(115.0),
        "y_max": pytest.approx(227.0),
    }


def test_worker_rejects_label_mapping_outside_the_ontology(tmp_path):
    double = SchedulingDouble()
    worker, out, image_path = _make_worker(tmp_path, double=double)
    worker.start()
    worker.handle_line(
        _start_run_line(image_path, "run-1", label_mapping={"person": "label_missing"}, ontology_label_ids=("label_person",))
    )
    rejected = [resp for resp in _responses(out) if resp["method"] == "start_run"]
    assert rejected[0]["ok"] is False and rejected[0]["error"]["code"] == "invalid_label_mapping"
    assert double.calls == []
    worker.shutdown()


def test_worker_rejects_non_detect_intent(tmp_path):
    double = SchedulingDouble()
    worker, out, image_path = _make_worker(tmp_path, double=double)
    worker.start()
    worker.handle_line(_start_run_line(image_path, "run-1", intent="audit_attributes"))
    rejected = [resp for resp in _responses(out) if resp["method"] == "start_run"]
    assert rejected[0]["ok"] is False and rejected[0]["error"]["code"] == "unsupported_intent"
    assert double.calls == []
    worker.shutdown()


def test_worker_rejects_missing_and_non_png_images(tmp_path):
    double = SchedulingDouble()
    worker, out, image_path = _make_worker(tmp_path, double=double)
    worker.start()
    worker.handle_line(_start_run_line(str(tmp_path / "missing.png"), "run-missing"))
    garbage = tmp_path / "garbage.png"
    garbage.write_bytes(b"not a png at all")
    worker.handle_line(_start_run_line(str(garbage), "run-garbage"))
    codes = {resp["run_id"]: resp["error"]["code"] for resp in _responses(out) if resp["method"] == "start_run"}
    assert codes == {"run-missing": "image_unreadable", "run-garbage": "invalid_image"}
    assert double.calls == []
    worker.shutdown()


# ---------------------------------------------------------------------------
# Worker over real stdio NDJSON: probe/run failure, protocol errors terminate,
# bounded buffers, one response per request.
# ---------------------------------------------------------------------------


def _spawn_worker(tmp_path: Path, weights_files=None) -> subprocess.Popen:
    if weights_files is None:
        weights_files = {"model.safetensors": b"fake"}
    _write_test_lock(tmp_path, weights_files)
    env = {
        "WEBLABEL_DETECTOR_MODELS_LOCK": str(tmp_path / "models.lock.json"),
        "WEBLABEL_DETECTOR_WEIGHTS_DIR": str(tmp_path),
        "SystemRoot": os.environ.get("SystemRoot", r"C:\Windows"),
        "PATH": "",
    }
    return subprocess.Popen(
        [sys.executable, "-m", "weblabel_detector"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        cwd=str(tmp_path),
    )


def _drain(proc: subprocess.Popen, close_stdin: bool = True, timeout: float = 30.0):
    if close_stdin:
        proc.stdin.close()
    out, err = proc.communicate(timeout=timeout)
    return proc.returncode, out.decode("utf-8"), err.decode("utf-8")


def _request(id: str, method: str, payload: dict) -> str:
    return serialize_envelope({"protocol_version": 1, "id": id, "kind": "request", "method": method, "payload": payload})


def test_subprocess_probe_reports_needs_configuration_on_both_dimensions(tmp_path):
    proc = _spawn_worker(tmp_path)
    proc.stdin.write((_request("probe-1", "probe", {}) + "\n" + _request("shutdown-1", "shutdown", {}) + "\n").encode("utf-8"))
    code, out, err = _drain(proc)
    assert code == 0, err
    lines = [json.loads(line) for line in out.splitlines()]
    assert [env["kind"] for env in lines] == ["response", "response"]
    profile = lines[0]["payload"]["profile"]
    assert lines[0]["payload"]["ok"] is True
    assert profile["provider_id"] == "detector_local"
    assert profile["availability"] == "needs_configuration"
    assert profile["verification"] == "not_run"
    assert profile["auth_kind"] == "local_weights"
    assert profile["model_id"] == "test/model@0000"
    assert lines[1]["payload"] == {"ok": True, "status": "shutdown"}


def test_subprocess_run_without_weights_fails_without_candidates_and_survives(tmp_path):
    proc = _spawn_worker(tmp_path)
    image_path = tmp_path / "input.png"
    image_path.write_bytes(_png_bytes())
    run_line = _start_run_line(str(image_path), "run-real")
    proc.stdin.write((run_line + "\n" + _request("probe-2", "probe", {}) + "\n" + _request("shutdown-1", "shutdown", {}) + "\n").encode("utf-8"))
    code, out, err = _drain(proc)
    assert code == 0, err
    lines = [json.loads(line) for line in out.splitlines()]
    responses = [env for env in lines if env["kind"] == "response"]
    events = [env["payload"] for env in lines if env["kind"] == "event"]
    run_response = next(r for r in responses if r["method"] == "start_run")
    assert run_response["payload"]["ok"] is False
    assert run_response["payload"]["status"] == "failed"
    assert run_response["payload"]["error"]["code"] == "needs_configuration"
    assert [event["type"] for event in events if event["run_id"] == "run-real"] == ["queued", "started", "failed"]
    assert not [event for event in events if event["type"] == "candidate"]
    assert any(r["method"] == "probe" and r["payload"]["ok"] for r in responses)


def test_subprocess_duplicate_request_id_and_unknown_run_cancel_get_error_responses(tmp_path):
    proc = _spawn_worker(tmp_path)
    proc.stdin.write(
        (
            _request("probe-1", "probe", {})
            + "\n"
            + _request("probe-1", "probe", {})
            + "\n"
            + _request("cancel-1", "cancel_run", {"run_id": "never-existed"})
            + "\n"
            + _request("shutdown-1", "shutdown", {})
            + "\n"
        ).encode("utf-8")
    )
    code, out, err = _drain(proc)
    assert code == 0, err
    payloads = [json.loads(line)["payload"] for line in out.splitlines()]
    assert payloads[0]["ok"] is True
    assert payloads[1]["ok"] is False and payloads[1]["error"]["code"] == "duplicate_request_id"
    assert payloads[2] == {"ok": False, "run_id": "never-existed", "error": {"code": "unknown_run"}}
    assert payloads[3] == {"ok": True, "status": "shutdown"}


def test_subprocess_invalid_start_run_payload_gets_an_error_response(tmp_path):
    proc = _spawn_worker(tmp_path)
    bad = json.dumps(
        {
            "protocol_version": 1,
            "id": "run-bad",
            "kind": "request",
            "method": "start_run",
            "payload": {"run_id": "run-bad", "unexpected": True},
        }
    )
    proc.stdin.write(
        (bad + "\n" + _request("probe-1", "probe", {}) + "\n" + _request("shutdown-1", "shutdown", {}) + "\n").encode("utf-8")
    )
    code, out, err = _drain(proc)
    assert code == 0, err  # payload-level errors answer the request; they never kill the worker
    payloads = [json.loads(line)["payload"] for line in out.splitlines()]
    assert payloads[0]["ok"] is False and payloads[0]["error"]["code"] == "invalid_payload"
    assert payloads[1]["ok"] is True  # the worker keeps serving afterwards
    assert payloads[2] == {"ok": True, "status": "shutdown"}


def test_worker_shutdown_drains_queued_runs_instead_of_cancelling_them(tmp_path):
    double = SchedulingDouble()
    worker, out, image_path = _make_worker(tmp_path, double=double)
    worker.start()
    worker.handle_line(_start_run_line(image_path, "run-drain"))
    # Shutdown immediately: a queued/uncancelled run must finish, never turn
    # into a spurious cancellation (the adapter closes stdin after terminal).
    worker.shutdown()
    kinds = [event["type"] for event in _events(out) if event["run_id"] == "run-drain"]
    assert kinds == ["queued", "started", "succeeded"]
    run_responses = [resp for resp in _responses(out) if resp.get("run_id") == "run-drain" and resp["method"] == "start_run"]
    assert run_responses and run_responses[0]["status"] == "succeeded"


def test_subprocess_unknown_method_terminates_the_protocol(tmp_path):
    proc = _spawn_worker(tmp_path)
    # A hostile/unknown method can never pass serialize_envelope (the host
    # mirrors this), so it is sent as a raw JSON line like a hostile peer would.
    proc.stdin.write(b'{"protocol_version":1,"id":"req-1","kind":"request","method":"shell_exec","payload":{}}\n')
    code, out, err = _drain(proc)
    assert code == 2
    assert "unknown_method" in err
    assert out.strip() == ""  # protocol violations never emit partial output


def test_subprocess_oversize_line_is_rejected_before_unbounded_buffering(tmp_path):
    proc = _spawn_worker(tmp_path)
    big = b"x" * (MAX_LINE_BYTES + 4096)  # no newline ever arrives
    try:
        proc.stdin.write(big)
        proc.stdin.flush()
    except (BrokenPipeError, OSError):
        pass
    # The worker must terminate while the writer still holds stdin open; a
    # naive implementation would keep buffering until EOF.
    for _ in range(300):
        if proc.poll() is not None:
            break
        threading.Event().wait(0.05)
    assert proc.poll() is not None, "worker kept buffering an oversize line instead of rejecting it"
    out, err = proc.communicate(timeout=10)
    assert proc.returncode == 2
    assert "message_too_large" in err.decode("utf-8")
    assert out.decode("utf-8").strip() == ""


def test_subprocess_truncated_message_at_eof_is_fatal(tmp_path):
    proc = _spawn_worker(tmp_path)
    proc.stdin.write(b'{"protocol_version":1,"id":"x","kind":"request","method":"probe"')
    code, out, err = _drain(proc)
    assert code == 2
    assert "truncated_message" in err
    assert out.strip() == ""


def test_default_paths_point_at_the_service_root():
    from weblabel_detector.__main__ import default_paths

    lock_path, weights_dir = default_paths()
    service_root = Path(__file__).resolve().parents[1]
    assert lock_path == str(service_root / "models.lock.json")
    assert weights_dir == str(service_root / "weights")
    assert Path(lock_path).is_file()  # the real lock ships with the service


# ---------------------------------------------------------------------------
# Protocol layer mirrors the host's error codes (docs/contracts.md C5).
# ---------------------------------------------------------------------------


def test_parse_envelope_mirrors_host_error_codes():
    with pytest.raises(ProtocolError) as err:
        parse_envelope(json.dumps({"protocol_version": 99, "id": "x", "kind": "request", "method": "probe", "payload": {}}))
    assert err.value.code == "protocol_version"
    with pytest.raises(ProtocolError) as err:
        parse_envelope("[]")
    assert err.value.code == "invalid_envelope"
    with pytest.raises(ProtocolError) as err:
        parse_envelope('{"protocol_version":1}\n{"protocol_version":1}')
    assert err.value.code == "multi_line_message"
    with pytest.raises(ProtocolError) as err:
        parse_envelope(json.dumps({"protocol_version": 1, "id": "x", "kind": "request", "method": "probe", "payload": {"blob": "y" * (MAX_LINE_BYTES)}}))
    assert err.value.code == "message_too_large"
    with pytest.raises(ProtocolError) as err:
        parse_envelope(json.dumps({"protocol_version": 1, "id": "x", "kind": "request", "method": "shell_exec", "payload": {}}))
    assert err.value.code == "unknown_method"
    with pytest.raises(ProtocolError) as err:
        parse_envelope(json.dumps({"protocol_version": 1, "id": "x", "kind": "event", "method": "start_run", "payload": {}}))
    assert err.value.code == "invalid_kind_method_pair"
    with pytest.raises(ProtocolError) as err:
        parse_envelope(json.dumps({"protocol_version": 1, "id": "x", "kind": "request", "method": "probe"}))
    assert err.value.code == "invalid_envelope"
    with pytest.raises(ProtocolError) as err:
        parse_envelope(json.dumps({"protocol_version": 1, "id": "", "kind": "request", "method": "probe", "payload": {}}))
    assert err.value.code == "invalid_id"
    assert parse_envelope(json.dumps({"protocol_version": 1, "id": "x", "kind": "request", "method": "probe", "payload": {}}))["method"] == "probe"
    assert "\n" not in serialize_envelope({"protocol_version": 1, "id": "x", "kind": "response", "method": "probe", "payload": {}})


def test_request_id_tracker_rejects_duplicates():
    tracker = RequestIdTracker()
    tracker.track("req-1")
    with pytest.raises(ProtocolError) as err:
        tracker.track("req-1")
    assert err.value.code == "duplicate_request_id"


def test_line_reader_bounds_partial_buffers_and_flags_truncation():
    reader = LineReader(io.BytesIO(b"line-1\r\nline-2\n"))
    assert list(reader) == ["line-1", "line-2"]
    # A newline-free flood must be rejected once it crosses the cap, without
    # waiting for the rest of the line.
    flood = LineReader(io.BytesIO(b"x" * (MAX_LINE_BYTES + 4096)))
    with pytest.raises(ProtocolError) as err:
        next(iter(flood))
    assert err.value.code == "message_too_large"
    truncated = LineReader(io.BytesIO(b'{"partial":'))
    with pytest.raises(ProtocolError) as err:
        next(iter(truncated))
    assert err.value.code == "truncated_message"
