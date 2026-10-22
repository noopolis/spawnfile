"""Multiplexed JSONL callbacks; stdout is reserved for the protocol."""

import json
import hashlib
from concurrent.futures import Future
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
        self._condition = threading.Condition(self._lock)
        self._pending = {}
        self._occurrences = {}
        self._failure = None
        self._reader = None

    def checkpoint(self):
        with self._lock:
            if self._pending:
                raise BridgeError("checkpoint_busy", "callbacks must settle before checkpointing")
            return dict(self._occurrences)

    def restore(self, occurrences):
        with self._lock:
            self._occurrences = dict(occurrences)

    def _fail(self, error):
        with self._lock:
            self._failure = error
            for waiter in self._pending.values():
                waiter.set_exception(error)
            self._pending.clear()

    def _read(self):
        try:
            while True:
                with self._condition:
                    self._condition.wait_for(lambda: bool(self._pending))
                try:
                    response = HostResponse.model_validate(read_message(self.reader))
                except ValidationError as error:
                    raise BridgeError("invalid_response", "host response violates the protocol") from error
                with self._lock:
                    waiter = self._pending.pop(response.id, None)
                    if waiter is None:
                        raise BridgeError("invalid_response", "host response does not match a pending callback")
                    if response.error is not None:
                        error = BridgeError(response.error.code, response.error.message)
                        waiter.set_exception(error)
                        raise error
                    waiter.set_result(response.result)
        except Exception as error:
            self._fail(error)

    def __call__(self, method: str, params: dict):
        # Content + occurrence identity is independent of worker scheduling and
        # completion order, including replay after the last paired checkpoint.
        key = hashlib.sha256(json.dumps([method, params], sort_keys=True,
                                       separators=(",", ":")).encode()).hexdigest()
        waiter = Future()
        with self._lock:
            if self._failure is not None:
                raise self._failure
            ordinal = self._occurrences.get(key, 0) + 1
            self._occurrences[key] = ordinal
            call_id = f"{key}:{ordinal}"
            self._pending[call_id] = waiter
            self._condition.notify()
            try:
                write_message(self.writer, {
                    "schema": SCHEMA, "kind": "request", "id": call_id,
                    "method": method, "params": params,
                })
            except Exception as error:
                self._failure = error
                for pending in self._pending.values():
                    pending.set_exception(error)
                self._pending.clear()
            if self._reader is None and self._failure is None:
                self._reader = threading.Thread(target=self._read, daemon=True)
                self._reader.start()
        return waiter.result()
