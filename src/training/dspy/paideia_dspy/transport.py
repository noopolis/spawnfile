"""Serial JSONL callbacks; stdout is reserved for the protocol."""

import json
import threading
from typing import BinaryIO, TextIO

from pydantic import ValidationError

from .protocol import SCHEMA, MAX_LINE_BYTES, BridgeError, HostResponse


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def parse_json(text):
    def invalid_constant(_value):
        raise ValueError("nonfinite JSON number")

    try:
        return json.loads(text, object_pairs_hook=_unique_object, parse_constant=invalid_constant)
    except (ValueError, UnicodeError) as error:
        raise BridgeError("invalid_json", "expected finite UTF-8 JSON with unique keys") from error


def read_message(stream: BinaryIO):
    line = stream.readline(MAX_LINE_BYTES + 1)
    if not line:
        raise BridgeError("host_disconnected", "host closed the JSONL input")
    if len(line) > MAX_LINE_BYTES or not line.endswith(b"\n"):
        raise BridgeError("invalid_frame", "JSONL frame is too large or lacks its final LF")
    try:
        decoded = line.decode("utf-8", errors="strict")
    except UnicodeError as error:
        raise BridgeError("invalid_json", "JSONL frames must be UTF-8") from error
    return parse_json(decoded)


def write_message(stream: TextIO, message: dict):
    text = json.dumps(message, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
    if len(text.encode("utf-8")) + 1 > MAX_LINE_BYTES:
        raise BridgeError("invalid_frame", "outgoing JSONL frame exceeds the size limit")
    stream.write(text + "\n")
    stream.flush()


class JsonlHost:
    def __init__(self, reader: BinaryIO, writer: TextIO):
        self.reader, self.writer = reader, writer
        self._lock = threading.Lock()
        self._sequence = 0

    def __call__(self, method: str, params: dict):
        with self._lock:
            self._sequence += 1
            call_id = f"call-{self._sequence}"
            write_message(self.writer, {
                "schema": SCHEMA, "kind": "request", "id": call_id,
                "method": method, "params": params,
            })
            try:
                response = HostResponse.model_validate(read_message(self.reader))
            except ValidationError as error:
                raise BridgeError("invalid_response", "host response violates the protocol") from error
            if response.id != call_id:
                raise BridgeError("invalid_response", "host response does not match the pending callback")
            if response.error is not None:
                raise BridgeError(response.error.code, response.error.message)
            return response.result
