"""One optimization per process. Protocol stdout; upstream diagnostics stderr."""

import contextlib
import sys
from typing import BinaryIO, TextIO

from pydantic import ValidationError

from .optimizer import optimize
from .protocol import SCHEMA, BridgeError, OptimizeRequest
from .transport import JsonlHost, read_message, write_message


def run(reader: BinaryIO, writer: TextIO, diagnostic: TextIO) -> int:
    request_id = "unknown"
    try:
        request = OptimizeRequest.model_validate(read_message(reader))
        request_id = request.id
        with contextlib.redirect_stdout(diagnostic):
            result = optimize(request, JsonlHost(reader, writer))
        write_message(writer, {"schema": SCHEMA, "kind": "result", "id": request_id, **result})
        return 0
    except Exception as error:
        if isinstance(error, BridgeError):
            code, message = error.code, str(error)
        elif isinstance(error, ValidationError):
            code, message = "invalid_request", "optimization request violates the protocol"
        else:
            code, message = "optimizer_error", f"DSPy optimization failed ({type(error).__name__})"
        write_message(writer, {"schema": SCHEMA, "kind": "error", "id": request_id,
                               "error": {"code": code, "message": message}})
        return 1


def cli():
    raise SystemExit(run(sys.stdin.buffer, sys.stdout, sys.stderr))
