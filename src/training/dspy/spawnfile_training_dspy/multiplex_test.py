import json
import queue
from concurrent.futures import ThreadPoolExecutor

import pytest

from .fixtures_test import request
from .protocol import BridgeError, SCHEMA
from .session import Session
from .transport import JsonlHost


class Reader:
    def __init__(self):
        self.lines = queue.Queue()

    def readline(self, _limit):
        return self.lines.get(timeout=3)


class Writer:
    def __init__(self):
        self.lines = queue.Queue()

    def write(self, text):
        assert text.count("\n") == 1
        self.lines.put(json.loads(text))

    def flush(self):
        pass


def test_out_of_order_responses_reach_exact_callers_and_replay_identity():
    reader, writer = Reader(), Writer()
    host = JsonlHost(reader, writer)
    with ThreadPoolExecutor(4) as workers:
        futures = [workers.submit(host, "evaluate", {"caseId": str(i)}) for i in range(4)]
        sent = [writer.lines.get(timeout=3) for _ in futures]
        with pytest.raises(BridgeError, match="settle"):
            host.checkpoint()
        for row in reversed(sent):
            reader.lines.put((json.dumps({"schema": SCHEMA, "kind": "response", "id": row["id"],
                                         "result": {"caseId": row["params"]["caseId"]}}) + "\n").encode())
        assert [future.result(timeout=3) for future in futures] == [{"caseId": str(i)} for i in range(4)]
    state = host.checkpoint()
    other = JsonlHost(Reader(), Writer())
    other.restore(state)
    assert other.checkpoint() == state
    # Fresh replay in the opposite scheduling order preserves request identities.
    replay_reader, replay_writer = Reader(), Writer()
    replay = JsonlHost(replay_reader, replay_writer)
    with ThreadPoolExecutor(4) as workers:
        futures = [workers.submit(replay, "evaluate", {"caseId": str(i)}) for i in reversed(range(4))]
        replayed = [replay_writer.lines.get(timeout=3) for _ in futures]
        assert {r["params"]["caseId"]: r["id"] for r in replayed} == {r["params"]["caseId"]: r["id"] for r in sent}
        for row in replayed:
            replay_reader.lines.put((json.dumps({"schema": SCHEMA, "kind": "response", "id": row["id"], "result": {}}) + "\n").encode())
        for future in futures:
            future.result(timeout=3)


@pytest.mark.parametrize("failure", ["disconnect", "host-error", "unknown-id"])
def test_disconnect_and_errors_fail_every_waiter(failure):
    reader, writer = Reader(), Writer()
    host = JsonlHost(reader, writer)
    with ThreadPoolExecutor(4) as workers:
        futures = [workers.submit(host, "evaluate", {"caseId": str(i)}) for i in range(4)]
        sent = [writer.lines.get(timeout=3) for _ in futures]
        reader.lines.put(b"" if failure == "disconnect" else (json.dumps({"schema": SCHEMA, "kind": "response",
            "id": sent[0]["id"] if failure == "host-error" else "unknown", "error": {"code": "stopped", "message": "stopped"}}) + "\n").encode())
        for future in futures:
            with pytest.raises(BridgeError):
                future.result(timeout=3)
        with pytest.raises(BridgeError):
            host("evaluate", {})


def test_session_releases_lock_and_reserves_before_callbacks():
    import threading
    barrier = threading.Barrier(4, timeout=3)
    def evaluate(_method, params):
        barrier.wait()
        return {"score": 1.0, "feedback": "", "output": "", "captureId": params["caseId"]}
    session = Session(request(trainCaseIds=["a", "b", "c", "d"], budget={"maxMetricCalls": 4, "maxProposals": 1}), evaluate)
    with ThreadPoolExecutor(4) as workers:
        futures = [workers.submit(session.evaluate, case, session.request.components) for case in "abcd"]
        assert [f.result(timeout=4).captureId for f in futures] == list("abcd")
    with pytest.raises(BridgeError, match="budget"):
        session.evaluate("a", session.request.components)
    assert len(session.results) == 4


def test_writer_failure_latches_without_starting_reader():
    class BrokenWriter(Writer):
        def write(self, _text):
            raise OSError("closed pipe")
    host = JsonlHost(Reader(), BrokenWriter())
    with pytest.raises(OSError, match="closed pipe"):
        host("evaluate", {})
    with pytest.raises(OSError, match="closed pipe"):
        host("generate", {})
    assert host._reader is None
