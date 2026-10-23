"""Explicit trusted-checkpoint forks; actual GEPA and exact host-journal replay."""
import hashlib
import json

import pytest
from pydantic import ValidationError

from .checkpoint import Checkpoint, _bytes
from .checkpoint_test import JournalHost
from .fixtures_test import request
from .optimizer import optimize
from .protocol import BridgeError
from .session import Session


def fork_request(parent, child, **overrides):
    values = {
        "id": "child-experiment",
        "checkpoint": {"directory": str(child), "identity": "new-execution", "fork": {
            "directory": str(parent), "identity": "execution", "id": "experiment-1",
            "digest": "sha256:" + hashlib.sha256((parent / "optimizer.json").read_bytes()).hexdigest(),
        }},
    }
    values.update(overrides)
    return request(**values)


def interrupted_parent(path):
    host = JournalHost()
    original = request(checkpoint={"directory": str(path), "identity": "execution"})
    with pytest.raises(BridgeError, match="deliberate"):
        optimize(original, host)
    return host


def tree_bytes(path):
    return {str(file.relative_to(path)): file.read_bytes() for file in path.rglob("*") if file.is_file()}


def test_fork_persists_identical_paired_state_before_callbacks_and_resumes_without_parent(tmp_path):
    parent, child = tmp_path / "parent", tmp_path / "child"
    host = interrupted_parent(parent)
    before = tree_bytes(parent)
    child_request = fork_request(parent, child)
    session = Session(child_request, host)
    Checkpoint(session)
    saved = json.loads((child / "optimizer.json").read_text())["payload"]
    old = json.loads(before["optimizer.json"])["payload"]
    assert {key: saved[key] for key in ("gepa", "session", "sampler")} == {
        key: old[key] for key in ("gepa", "session", "sampler")}
    assert saved["identity"] != old["identity"]
    assert saved["lineage"] == {"parent": child_request.checkpoint.fork.model_dump(), "previous": None}
    assert len(host.subject.calls) == 3
    assert tree_bytes(parent) == before
    # Exact child resume depends on its committed copy, not mutable parent availability.
    parent.rename(tmp_path / "offline-parent")
    result = optimize(child_request, host)
    assert result["provenance"]["evaluations"] == 7
    assert result["provenance"]["proposals"] == 2
    assert len(host.subject.calls) == 9
    assert optimize(child_request, host) == result
    assert len(host.subject.calls) == 9
    assert json.loads((child / "optimizer.json").read_text())["payload"]["lineage"] == saved["lineage"]


@pytest.mark.parametrize("change", ["bytes", "payload", "identity", "budget", "components", "splits", "seed", "proposal", "same-id", "same-directory", "nested-directory", "ancestor-directory", "malformed", "gepa"])
def test_fork_rejects_tampering_or_request_drift_before_callbacks(tmp_path, change):
    parent, child = tmp_path / "parent", tmp_path / "child"
    host = interrupted_parent(parent)
    values = fork_request(parent, child).model_dump(by_alias=True)
    if change in {"bytes", "payload", "malformed", "gepa"}:
        file = parent / "optimizer.json"
        if change == "bytes":
            file.write_bytes(file.read_bytes() + b"\n")
        elif change == "malformed":
            file.write_bytes(b"{broken")
        else:
            envelope = json.loads(file.read_text())
            envelope["payload"]["gepa"] = "!invalid!"
            if change == "gepa":
                envelope["digest"] = hashlib.sha256(_bytes(envelope["payload"])).hexdigest()
            file.write_text(json.dumps(envelope))
        if change != "bytes":
            values["checkpoint"]["fork"]["digest"] = "sha256:" + hashlib.sha256(file.read_bytes()).hexdigest()
    elif change == "identity":
        values["checkpoint"]["fork"]["identity"] = "other-execution"
    elif change == "budget":
        values["budget"]["maxMetricCalls"] += 1
    elif change == "components":
        values["components"]["AGENTS.md"] = "changed"
    elif change == "splits":
        values["trainCaseIds"] = ["different-train"]
    elif change == "seed":
        values["seed"] += 1
    elif change == "proposal":
        values["proposal"] = {"strategy": "rewrite"}
    elif change == "same-id":
        values["id"] = values["checkpoint"]["fork"]["id"]
    elif change == "nested-directory":
        values["checkpoint"]["directory"] = str(parent / "child")
    elif change == "ancestor-directory":
        values["checkpoint"]["directory"] = str(tmp_path)
    else:
        values["checkpoint"]["directory"] = str(parent)
    before = tree_bytes(parent)
    count = len(host.subject.calls)
    with pytest.raises(BridgeError, match="checkpoint"):
        optimize(request(**values), host)
    assert len(host.subject.calls) == count
    assert tree_bytes(parent) == before
    assert not (child / "optimizer.json").exists()


def test_child_resume_cannot_drop_or_replace_lineage_and_nested_fork_retains_it(tmp_path):
    parent, child, grandchild = [tmp_path / name for name in ("parent", "child", "grandchild")]
    host = interrupted_parent(parent)
    original = fork_request(parent, child)
    Checkpoint(Session(original, host))
    for fork in (None, original.checkpoint.fork.model_copy(update={"digest": "sha256:" + "0" * 64})):
        changed = original.model_copy(update={"checkpoint": original.checkpoint.model_copy(update={"fork": fork})})
        with pytest.raises(BridgeError, match="lineage"):
            Checkpoint(Session(changed, host))
    nested = fork_request(child, grandchild, id="grandchild").model_dump(by_alias=True)
    nested["checkpoint"]["fork"].update(identity="new-execution", id="child-experiment")
    Checkpoint(Session(request(**nested), host))
    line = json.loads((grandchild / "optimizer.json").read_text())["payload"]["lineage"]
    assert line["previous"]["parent"] == original.checkpoint.fork.model_dump()
    assert line["parent"]["id"] == "child-experiment"


@pytest.mark.parametrize("digest", ["bad", "sha256:" + "A" * 64, "sha256:" + "0" * 63])
def test_fork_digest_is_strictly_authored(digest):
    with pytest.raises(ValidationError):
        request(checkpoint={"directory": "child", "identity": "new", "fork": {
            "directory": "parent", "identity": "old", "id": "old-id", "digest": digest}})


class LaggingHost(JournalHost):
    def __init__(self):
        super().__init__(fail_at=17)
        subject = self.subject
        self.calls = []

        def invoke(method, params):
            result = subject(method, params)
            if method == "evaluate":
                revisions = min(text.count("Revision ") for text in params["components"].values())
                result["score"] = 0.5 if revisions == 1 else (0.25 if revisions else 0)
            return result

        self.subject = invoke
        self.native = subject

    def __call__(self, method, params):
        self.calls.append((self._sequence + 1, method))
        return super().__call__(method, params)


def test_real_gepa_fork_replays_two_completed_callbacks_then_pending_call17(tmp_path):
    parent, child = tmp_path / "parent", tmp_path / "child"
    host = LaggingHost()
    budget = {"maxMetricCalls": 30, "maxProposals": 6}
    original = request(budget=budget, checkpoint={"directory": str(parent), "identity": "execution"})
    with pytest.raises(BridgeError, match="deliberate"):
        optimize(original, host)
    before = tree_bytes(parent)
    saved = json.loads(before["optimizer.json"])["payload"]
    assert len(saved["session"]["results"]) == 14
    assert len(host.entries) == 16
    assert host.calls[-1] == (17, "evaluate")
    prior_generations = host.native.generation_count
    host.calls.clear()
    child_request = fork_request(parent, child, budget=budget)
    result = optimize(child_request, host)
    assert host.calls[:3] == [(15, "evaluate"), (16, "generate"), (17, "evaluate")]
    assert host.native.generation_count == prior_generations + 1  # only the sixth, later proposal
    assert len(host.native.calls) == len(host.entries)
    assert result["provenance"]["proposals"] == 6
    assert result["provenance"]["evaluations"] <= budget["maxMetricCalls"]
    assert tree_bytes(parent) == before
    count = len(host.native.calls)
    assert optimize(child_request, host) == result
    assert len(host.native.calls) == count


def test_fork_missing_parent_fails_before_callback_and_recovery_budget_stays_consumed(tmp_path):
    parent, child = tmp_path / "parent", tmp_path / "child"
    host = interrupted_parent(parent)
    child_request = fork_request(parent, child, recovery={"evaluations": 9, "proposals": 2})
    session = Session(child_request, host)
    Checkpoint(session)
    assert session.evaluations == 1 and session.extra_evaluations == 9
    assert session.should_stop(None)
    with pytest.raises(BridgeError, match="budget"):
        session.generate([], {})
    missing = fork_request(parent, tmp_path / "missing-child").model_dump(by_alias=True)
    missing["checkpoint"]["fork"]["directory"] = str(tmp_path / "absent")
    with pytest.raises(BridgeError, match="integrity"):
        optimize(request(**missing), host)
    assert len(host.subject.calls) == 3
