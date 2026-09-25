"""NDJSON stdio entry point for the optional CPU detector worker.

stdout carries protocol envelopes only; logs go to stderr. The worker processes
one run at a time (single worker, concurrency 1), keeps a bounded pending
queue, and cancels waiting items on request. Runs produce candidates only —
the worker never writes AnnotationRevision or any document state.

Image bytes never travel inside protocol lines (contracts C5): the host passes
the path of a staged, grant-approved image plus its ``transform_to_canonical``
matrix; detections are returned in canonical continuous pixels.
"""

from __future__ import annotations

import os
import sys
import threading
from collections import deque
from dataclasses import dataclass
from pathlib import Path

from .labels import LabelMapping, LabelMappingError
from .model import DetectorError, ProbeStatus, build_candidate_raw, compose_probe, probe_status, project_detections
from .protocol import LineReader, ProtocolError, RequestIdTracker, parse_envelope, serialize_envelope

MAX_PENDING_RUNS = 8
MAX_IMAGE_BYTES = 128 * 1024 * 1024
MAX_PATH_LENGTH = 1024
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


@dataclass
class _Run:
    run_id: str
    request_id: str
    image_path: str
    transform: list[float]
    label_mapping: LabelMapping
    canonical_width: float
    canonical_height: float
    seq: int = 0
    state: str = "queued"
    cancelled: bool = False


def _require_string(value, name: str, *, max_length: int = 128) -> str:
    if not isinstance(value, str) or not value or len(value) > max_length:
        raise ProtocolError("invalid_payload", f"{name} must be a non-empty string of at most {max_length} characters")
    return value


def _parse_transform(value) -> list[float]:
    if not isinstance(value, list) or len(value) != 9:
        raise ProtocolError("invalid_payload", "transform_to_canonical must be a 9-number row-major 3x3 matrix")
    transform: list[float] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not (-1e308 < float(item) < 1e308):
            raise ProtocolError("invalid_payload", "transform_to_canonical must contain finite numbers")
        transform.append(float(item))
    return transform


def _parse_size(value) -> tuple[float, float]:
    if not isinstance(value, dict):
        raise ProtocolError("invalid_payload", "canonical_size must be an object with width and height")
    width = value.get("width")
    height = value.get("height")
    for name, number in (("width", width), ("height", height)):
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not (0 < float(number) < 1e308):
            raise ProtocolError("invalid_payload", f"canonical_size.{name} must be a positive number")
    return float(width), float(height)


class Worker:
    """Single-threaded-batch detector worker with a bounded pending queue.

    Request parsing and validation happen synchronously in ``handle_line``;
    model work runs on one background processing thread (concurrency 1) so
    waiting runs can be cancelled while another run is in flight.
    """

    def __init__(self, *, lock_path, weights_dir, out, predictor_factory=None, max_pending=MAX_PENDING_RUNS, find_spec=None):
        if isinstance(max_pending, bool) or not isinstance(max_pending, int) or not (1 <= max_pending <= 1024):
            raise ValueError("max_pending must be in 1..1024")
        self._lock_path = Path(lock_path)
        self._weights_dir = Path(weights_dir)
        self._out = out
        self._write_lock = threading.Lock()
        self._find_spec = find_spec
        self._predictor_factory = predictor_factory
        self._max_pending = max_pending
        self._requests = RequestIdTracker()
        self._runs: dict[str, _Run] = {}
        self._queue: deque[_Run] = deque()
        self._cond = threading.Condition()
        self._running: _Run | None = None
        self._stopping = False
        self._thread: threading.Thread | None = None

    # -- output ------------------------------------------------------------

    def _write(self, envelope: dict) -> None:
        line = serialize_envelope(envelope)
        with self._write_lock:
            self._out.write(line + "\n")
            flush = getattr(self._out, "flush", None)
            if callable(flush):
                flush()

    def _respond(self, request_id: str, method: str, payload: dict) -> None:
        self._write({"protocol_version": 1, "id": request_id, "kind": "response", "method": method, "payload": payload})

    def _emit(self, run: _Run, event_type: str, message: str, data) -> None:
        run.seq += 1
        self._write(
            {
                "protocol_version": 1,
                "id": run.run_id,
                "kind": "event",
                "method": "run_event",
                "payload": {"run_id": run.run_id, "seq": run.seq, "type": event_type, "message": message, "data": data},
            }
        )

    # -- request handling --------------------------------------------------

    def handle_line(self, line: str) -> None:
        envelope = parse_envelope(line)
        try:
            self._requests.track(envelope["id"])
        except ProtocolError as error:
            if error.code != "duplicate_request_id":
                raise
            self._respond(envelope["id"], envelope["method"], {"ok": False, "error": {"code": error.code, "message": error.message}})
            return
        method = envelope["method"]
        try:
            if method == "probe":
                self._handle_probe(envelope)
            elif method == "start_run":
                self._handle_start_run(envelope)
            elif method == "cancel_run":
                self._handle_cancel_run(envelope)
            elif method == "shutdown":
                self._respond(envelope["id"], "shutdown", {"ok": True, "status": "shutdown"})
                self.shutdown()
        except ProtocolError as error:
            # Payload-level failures are answered per request (C5: every request
            # gets a response); only envelope/framing violations kill the worker.
            self._respond(
                envelope["id"],
                method,
                {"ok": False, "error": {"code": error.code, "message": error.message}},
            )
        except OSError as error:
            self._respond(
                envelope["id"],
                method,
                {"ok": False, "error": {"code": "probe_failed", "message": type(error).__name__}},
            )

    def _handle_probe(self, envelope: dict) -> None:
        status: ProbeStatus = probe_status(self._lock_path, self._weights_dir, find_spec=self._find_spec)
        profile = compose_probe(
            status.model_id,
            weights_ok=status.weights_ok,
            weights_error=status.weights_error,
            missing_runtime=status.missing_runtime,
        )
        self._respond(envelope["id"], "probe", {"ok": True, "profile": profile})

    def _handle_start_run(self, envelope: dict) -> None:
        payload = envelope["payload"]
        if not isinstance(payload, dict):
            raise ProtocolError("invalid_payload", "start_run payload must be an object")
        allowed = {"run_id", "request", "image", "label_mapping", "ontology_label_ids", "canonical_size"}
        if set(payload.keys()) - allowed:
            raise ProtocolError("invalid_payload", "start_run payload has unknown fields")
        run_id = _require_string(payload.get("run_id"), "run_id")
        if run_id != envelope["id"]:
            raise ProtocolError("invalid_payload", "start_run envelope id must equal run_id")
        request = payload.get("request")
        if not isinstance(request, dict):
            raise ProtocolError("invalid_payload", "start_run requires the run request")
        image = payload.get("image")
        if not isinstance(image, dict) or set(image.keys()) - {"path", "transform_to_canonical"}:
            raise ProtocolError("invalid_payload", "image must be an object with path and transform_to_canonical")
        image_path = _require_string(image.get("path"), "image.path", max_length=MAX_PATH_LENGTH)
        if "\0" in image_path:
            raise ProtocolError("invalid_payload", "image.path must not contain NUL")
        transform = _parse_transform(image.get("transform_to_canonical"))
        canonical_width, canonical_height = _parse_size(payload.get("canonical_size"))
        ontology = payload.get("ontology_label_ids")
        if not isinstance(ontology, list) or len(ontology) > 4096:
            raise ProtocolError("invalid_payload", "ontology_label_ids must be a list")
        valid_label_ids = set()
        for label_id in ontology:
            valid_label_ids.add(_require_string(label_id, "ontology_label_ids entry"))
        raw_mapping = payload.get("label_mapping")
        if not isinstance(raw_mapping, dict):
            raise ProtocolError("invalid_payload", "label_mapping must be an object")
        with self._cond:
            if run_id in self._runs:
                raise ProtocolError("duplicate_run", f"run {run_id} already exists")
            if self._stopping:
                self._respond(envelope["id"], "start_run", {"ok": False, "run_id": run_id, "status": "failed", "error": {"code": "shutting_down", "message": "worker is shutting down"}})
                return
            if len(self._queue) >= self._max_pending:
                self._respond(envelope["id"], "start_run", {"ok": False, "run_id": run_id, "status": "failed", "error": {"code": "queue_full", "message": f"at most {self._max_pending} runs may wait"}})
                return
        # Semantic validation (responses, never fabricated progress).
        intent = request.get("intent")
        if intent != "detect":
            self._respond(envelope["id"], "start_run", {"ok": False, "run_id": run_id, "status": "failed", "error": {"code": "unsupported_intent", "message": "the detector only supports intent 'detect'"}})
            return
        try:
            label_mapping = LabelMapping.from_raw(raw_mapping, valid_label_ids=valid_label_ids)
        except LabelMappingError as error:
            self._respond(envelope["id"], "start_run", {"ok": False, "run_id": run_id, "status": "failed", "error": {"code": "invalid_label_mapping", "message": error.message}})
            return
        image_error = self._validate_image(image_path)
        if image_error is not None:
            self._respond(envelope["id"], "start_run", {"ok": False, "run_id": run_id, "status": "failed", "error": {"code": image_error, "message": f"image rejected: {image_error}"}})
            return
        run = _Run(
            run_id=run_id,
            request_id=envelope["id"],
            image_path=image_path,
            transform=transform,
            label_mapping=label_mapping,
            canonical_width=canonical_width,
            canonical_height=canonical_height,
        )
        with self._cond:
            if run_id in self._runs:
                raise ProtocolError("duplicate_run", f"run {run_id} already exists")
            self._runs[run_id] = run
            self._queue.append(run)
            self._cond.notify_all()
        self._emit(run, "queued", "run queued", None)

    @staticmethod
    def _validate_image(image_path: str) -> str | None:
        try:
            stat = os.stat(image_path)
        except OSError:
            return "image_unreadable"
        if stat.st_size > MAX_IMAGE_BYTES:
            return "image_too_large"
        try:
            with open(image_path, "rb") as handle:
                magic = handle.read(len(PNG_MAGIC))
        except OSError:
            return "image_unreadable"
        if magic != PNG_MAGIC:
            return "invalid_image"
        return None

    def _handle_cancel_run(self, envelope: dict) -> None:
        payload = envelope["payload"]
        if not isinstance(payload, dict):
            raise ProtocolError("invalid_payload", "cancel_run payload must be an object")
        run_id = _require_string(payload.get("run_id"), "run_id")
        with self._cond:
            run = self._runs.get(run_id)
            if run is None:
                self._respond(envelope["id"], "cancel_run", {"ok": False, "run_id": run_id, "error": {"code": "unknown_run"}})
                return
            if run.state == "queued":
                self._queue.remove(run)
                run.state = "cancelled"
                run.cancelled = True
                self._cond.notify_all()
                self._respond(envelope["id"], "cancel_run", {"ok": True, "run_id": run_id, "status": "cancelled"})
                self._emit(run, "cancelled", "run cancelled while waiting", None)
                self._respond(run.request_id, "start_run", {"ok": False, "run_id": run_id, "status": "cancelled"})
                return
            if run.state == "running":
                run.cancelled = True
                self._respond(envelope["id"], "cancel_run", {"ok": True, "run_id": run_id, "status": "cancelled"})
                return
            self._respond(envelope["id"], "cancel_run", {"ok": True, "run_id": run_id, "status": run.state})

    # -- processing --------------------------------------------------------

    def start(self) -> None:
        with self._cond:
            if self._thread is not None:
                return
            self._thread = threading.Thread(target=self._process_loop, name="weblabel-detector", daemon=True)
            self._thread.start()

    def _process_loop(self) -> None:
        while True:
            with self._cond:
                while not self._queue and not self._stopping:
                    self._cond.wait()
                # A stopping worker drains queued work first: shutdown must not
                # turn an uncancelled run into a spurious cancellation.
                if self._stopping and not self._queue:
                    return
                run = self._queue.popleft()
                run.state = "running"
                self._running = run
            try:
                self._process_run(run)
            finally:
                with self._cond:
                    self._running = None
                    self._cond.notify_all()

    def _process_run(self, run: _Run) -> None:
        self._emit(run, "started", "model run started", None)
        if run.cancelled:
            self._finish_cancelled(run)
            return
        try:
            predictor = self._default_predictor() if self._predictor_factory is None else self._predictor_factory()
            result = predictor.predict(run.image_path, label_mapping=run.label_mapping)
        except DetectorError as error:
            self._finish_failed(run, error.code, error.message)
            return
        except Exception as error:  # provider output is untrusted; fail closed
            self._finish_failed(run, "detector_error", f"{type(error).__name__}")
            return
        if run.cancelled:
            self._finish_cancelled(run)
            return
        try:
            projected = project_detections(
                result,
                transform_to_canonical=run.transform,
                canonical_width=run.canonical_width,
                canonical_height=run.canonical_height,
            )
            raw = None
            if projected.detections or projected.unsupported:
                raw = build_candidate_raw(projected, run_id=run.run_id)
        except DetectorError as error:
            self._finish_failed(run, error.code, error.message)
            return
        if run.cancelled:
            self._finish_cancelled(run)
            return
        if raw is not None:
            self._emit(run, "candidate", "detector candidate batch", {"raw": raw})
        self._finish_succeeded(run)

    def _default_predictor(self):
        from .model import Predictor  # noqa: PLC0415 — lazy so the offline suite never loads the real stack

        return Predictor.load(self._lock_path, self._weights_dir, find_spec=self._find_spec)

    def _finish_succeeded(self, run: _Run) -> None:
        run.state = "succeeded"
        self._emit(run, "succeeded", "model run succeeded", None)
        self._respond(run.request_id, "start_run", {"ok": True, "run_id": run.run_id, "status": "succeeded"})

    def _finish_failed(self, run: _Run, code: str, message: str) -> None:
        run.state = "failed"
        self._emit(run, "failed", "model run failed", {"code": code, "message": message})
        self._respond(run.request_id, "start_run", {"ok": False, "run_id": run.run_id, "status": "failed", "error": {"code": code, "message": message}})

    def _finish_cancelled(self, run: _Run) -> None:
        run.state = "cancelled"
        self._emit(run, "cancelled", "run cancelled", None)
        self._respond(run.request_id, "start_run", {"ok": False, "run_id": run.run_id, "status": "cancelled"})

    # -- lifecycle ---------------------------------------------------------

    @property
    def stopping(self) -> bool:
        return self._stopping

    def wait_idle(self, timeout: float = 20.0) -> None:
        with self._cond:
            if not self._cond.wait_for(lambda: not self._queue and self._running is None, timeout=timeout):
                raise RuntimeError("worker did not become idle in time")

    def shutdown(self, drain_timeout: float = 20.0) -> None:
        with self._cond:
            self._stopping = True
            self._cond.notify_all()
            thread = self._thread
        # Graceful drain: queued and in-flight runs finish within the budget
        # (the adapter keeps stdin open until its terminal event, so EOF never
        # cancels an uncancelled run). Only work left after the deadline is
        # cancelled, with an explicit terminal event and response.
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=drain_timeout)
        with self._cond:
            while self._queue:
                run = self._queue.popleft()
                run.state = "cancelled"
                self._emit(run, "cancelled", "run cancelled at shutdown", None)
                self._respond(run.request_id, "start_run", {"ok": False, "run_id": run.run_id, "status": "cancelled"})
            self._cond.notify_all()


def default_paths() -> tuple[str, str]:
    """Default lock/weights locations: the service root above ``src/``."""
    base = Path(__file__).resolve().parents[2]
    return str(base / "models.lock.json"), str(base / "weights")


def main() -> int:
    default_lock, default_weights = default_paths()
    lock_path = os.environ.get("WEBLABEL_DETECTOR_MODELS_LOCK") or default_lock
    weights_dir = os.environ.get("WEBLABEL_DETECTOR_WEIGHTS_DIR") or default_weights
    worker = Worker(lock_path=lock_path, weights_dir=weights_dir, out=sys.stdout)
    worker.start()
    try:
        for line in LineReader(sys.stdin.buffer):
            worker.handle_line(line)
            if worker.stopping:
                break
    except ProtocolError as error:
        # Protocol violations terminate the worker; the host reclaims the tree.
        # Nothing is resent automatically (contracts C5).
        print(f"[detector] protocol error {error.code}: {error.message}", file=sys.stderr)
        worker.shutdown()
        return 2
    except Exception as error:  # never leak partial protocol on unexpected failure
        print(f"[detector] internal error: {type(error).__name__}", file=sys.stderr)
        worker.shutdown()
        return 1
    worker.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
