import io
import json
import selectors
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from .fixtures_test import SimulatedHost, request
from .main import cli, run
from .protocol import SCHEMA


class ReactiveReader:
    def __init__(self, start, writer, host):
        self.start, self.writer, self.host = start, writer, host

    def readline(self, _size):
        if self.start is not None:
            line, self.start = self.start, None
            return (json.dumps(line) + "\n").encode()
        outgoing = json.loads(self.writer.getvalue().splitlines()[-1])
        reply = {"schema": SCHEMA, "kind": "response", "id": outgoing["id"],
                 "result": self.host(outgoing["method"], outgoing["params"])}
        return (json.dumps(reply) + "\n").encode()


def test_main_runs_real_gepa_and_reserves_stdout_for_complete_jsonl():
    writer, diagnostic = io.StringIO(), io.StringIO()
    reader = ReactiveReader(request().model_dump(by_alias=True), writer, SimulatedHost())
    assert run(reader, writer, diagnostic) == 0
    messages = [json.loads(line) for line in writer.getvalue().splitlines()]
    assert [message["kind"] for message in messages] == ["request"] * 9 + ["result"]
    assert messages[-1]["provenance"]["evaluations"] == 7
    assert messages[-1]["provenance"]["proposals"] == 2
    assert messages[-1]["provenance"]["candidates"][-1]["validationScore"] == 1
    assert "Average Metric" in diagnostic.getvalue()


@pytest.mark.parametrize("raw,code", [(b"", "host_disconnected"), (b"{}\n", "invalid_request")])
def test_rejected_start_has_explicit_error_and_nonzero_exit(raw, code):
    writer = io.StringIO()
    assert run(io.BytesIO(raw), writer, io.StringIO()) == 1
    terminal = json.loads(writer.getvalue())
    assert terminal["kind"] == "error"
    assert terminal["id"] == "unknown"
    assert terminal["error"]["code"] == code


def test_unexpected_upstream_failure_is_not_a_success_or_raw_data_dump(monkeypatch):
    def fail(*args):
        raise RuntimeError("raw upstream sensitive data")

    monkeypatch.setattr("paideia_dspy.main.optimize", fail)
    writer = io.StringIO()
    assert run(io.BytesIO((request().model_dump_json(by_alias=True) + "\n").encode()), writer, io.StringIO()) == 1
    terminal = json.loads(writer.getvalue())
    assert terminal["error"] == {"code": "optimizer_error", "message": "DSPy optimization failed (RuntimeError)"}
    assert terminal["id"] == "experiment-1"


def test_cli_maps_protocol_outcome_to_process_exit(monkeypatch):
    reader, writer, diagnostic = io.BytesIO(), io.StringIO(), io.StringIO()
    monkeypatch.setattr(sys, "stdin", SimpleNamespace(buffer=reader))
    monkeypatch.setattr(sys, "stdout", writer)
    monkeypatch.setattr(sys, "stderr", diagnostic)
    with pytest.raises(SystemExit) as error:
        cli()
    assert error.value.code == 1
    assert json.loads(writer.getvalue())["error"]["code"] == "host_disconnected"


def test_installed_process_exchanges_real_jsonl_and_produces_optimization():
    executable = Path(sys.executable).with_name("paideia-dspy")
    host = SimulatedHost()
    terminal = None
    with tempfile.TemporaryFile(mode="w+") as diagnostic:
        process = subprocess.Popen([str(executable)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=diagnostic, text=True, bufsize=1)
        try:
            process.stdin.write(request().model_dump_json(by_alias=True) + "\n")
            process.stdin.flush()
            with selectors.DefaultSelector() as watch:
                watch.register(process.stdout, selectors.EVENT_READ)
                for _ in range(20):
                    assert watch.select(timeout=10), "bridge failed to make bounded progress"
                    line = process.stdout.readline()
                    assert line, "bridge exited without a terminal result"
                    message = json.loads(line)
                    if message["kind"] != "request":
                        terminal = message
                        break
                    result = host(message["method"], message["params"])
                    process.stdin.write(json.dumps({"schema": SCHEMA, "kind": "response",
                                                   "id": message["id"], "result": result}) + "\n")
                    process.stdin.flush()
            assert process.wait(timeout=10) == 0
            assert terminal["kind"] == "result"
            assert terminal["provenance"]["proposals"] == 2
            assert terminal["provenance"]["selectedCandidateIndex"] == 2
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdin.close()
            process.stdout.close()
