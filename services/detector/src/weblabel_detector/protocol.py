"""Private NDJSON runtime protocol (docs/contracts.md C5).

Mirrors apps/agent-host/src/protocol.ts exactly: one JSON message per line,
4 MiB per-line cap enforced BEFORE decode with bounded buffering, and the same
stable ProtocolError codes as the TypeScript host.
"""

from __future__ import annotations

import json

PROTOCOL_VERSION = 1
MAX_LINE_BYTES = 4 * 1024 * 1024
MAX_ID_LENGTH = 128
READ_CHUNK = 65536
ENVELOPE_KINDS = ("request", "response", "event")
ENVELOPE_METHODS = ("probe", "start_run", "cancel_run", "shutdown", "run_event")
REQUEST_METHODS = ("probe", "start_run", "cancel_run", "shutdown")


class ProtocolError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def _utf8_length(text: str) -> int:
    try:
        return len(text.encode("utf-8"))
    except UnicodeEncodeError as error:
        raise ProtocolError("invalid_line", "line is not valid UTF-8") from error


def _assert_valid_envelope(decoded) -> dict:
    if not isinstance(decoded, dict):
        raise ProtocolError("invalid_envelope", "envelope must be a JSON object")
    if decoded.get("protocol_version") != PROTOCOL_VERSION:
        raise ProtocolError("protocol_version", f"expected {PROTOCOL_VERSION}, got {decoded.get('protocol_version')!r}")
    request_id = decoded.get("id")
    if not isinstance(request_id, str) or not request_id or len(request_id) > MAX_ID_LENGTH:
        raise ProtocolError("invalid_id", f"id must be a non-empty string of at most {MAX_ID_LENGTH} characters")
    kind = decoded.get("kind")
    if kind not in ENVELOPE_KINDS:
        raise ProtocolError("invalid_kind", repr(kind))
    method = decoded.get("method")
    if method not in ENVELOPE_METHODS:
        raise ProtocolError("unknown_method", repr(method))
    if kind == "request" and method not in REQUEST_METHODS:
        raise ProtocolError("invalid_kind_method_pair", f"{method} cannot be a request")
    if kind == "event" and method != "run_event":
        raise ProtocolError("invalid_kind_method_pair", f"{method} cannot be an event")
    if "payload" not in decoded:
        raise ProtocolError("invalid_envelope", "payload field is required")
    return {
        "protocol_version": PROTOCOL_VERSION,
        "id": request_id,
        "kind": kind,
        "method": method,
        "payload": decoded["payload"],
    }


def parse_envelope(line):
    if not isinstance(line, str):
        raise ProtocolError("invalid_line", "envelope must be a string line")
    if "\n" in line or "\r" in line:
        raise ProtocolError("multi_line_message", "an envelope must occupy exactly one line")
    byte_length = _utf8_length(line)
    if byte_length > MAX_LINE_BYTES:
        raise ProtocolError("message_too_large", f"{byte_length} bytes exceeds the {MAX_LINE_BYTES} byte limit")
    try:
        decoded = json.loads(line)
    except ValueError as error:
        raise ProtocolError("invalid_json", str(error)) from error
    return _assert_valid_envelope(decoded)


def serialize_envelope(envelope):
    validated = _assert_valid_envelope(dict(envelope))
    line = json.dumps(validated, separators=(",", ":"), ensure_ascii=False)
    byte_length = _utf8_length(line)
    if byte_length > MAX_LINE_BYTES:
        raise ProtocolError("message_too_large", f"{byte_length} bytes exceeds the {MAX_LINE_BYTES} byte limit")
    return line


class LineReader:
    """Incremental NDJSON line reader with bounded memory.

    A newline-free flood is rejected the moment the partial line crosses the
    4 MiB cap — the rest of the line is never buffered — and a stream that ends
    mid-message is a fatal ``truncated_message``.
    """

    def __init__(self, stream):
        self._stream = stream
        self._pending = bytearray()
        self._read = getattr(stream, "read1", None) or stream.read

    def __iter__(self):
        while True:
            chunk = self._read(READ_CHUNK)
            if not chunk:
                if self._pending:
                    self._pending.clear()
                    raise ProtocolError("truncated_message", "stream ended in the middle of a message")
                return
            self._pending.extend(chunk)
            while True:
                newline = self._pending.find(b"\n")
                if newline < 0:
                    break
                raw = bytes(self._pending[:newline])
                del self._pending[: newline + 1]
                if raw.endswith(b"\r"):
                    raw = raw[:-1]
                if len(raw) > MAX_LINE_BYTES:
                    self._pending.clear()
                    raise ProtocolError("message_too_large", f"streamed line exceeds the {MAX_LINE_BYTES} byte limit")
                try:
                    line = raw.decode("utf-8")
                except UnicodeDecodeError as error:
                    self._pending.clear()
                    raise ProtocolError("invalid_line", "line is not valid UTF-8") from error
                yield line
            if len(self._pending) > MAX_LINE_BYTES:
                self._pending.clear()
                raise ProtocolError("message_too_large", f"streamed line exceeds the {MAX_LINE_BYTES} byte limit")


class RequestIdTracker:
    def __init__(self):
        self._seen: set[str] = set()

    def track(self, request_id):
        if not isinstance(request_id, str) or not request_id or len(request_id) > MAX_ID_LENGTH:
            raise ProtocolError("invalid_id", f"id must be a non-empty string of at most {MAX_ID_LENGTH} characters")
        if request_id in self._seen:
            raise ProtocolError("duplicate_request_id", f"request id {request_id} was already used")
        self._seen.add(request_id)
