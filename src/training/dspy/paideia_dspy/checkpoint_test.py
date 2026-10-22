import json

import pytest

from .checkpoint import Checkpoint
from .fixtures_test import SimulatedHost, request
from .optimizer import optimize
from .protocol import BridgeError
from .session import Session


class JournalHost:
    def __init__(self, fail_at=4):
        self.fail_at = fail_at
        self._sequence = 0
        self.entries = {}
        self.subject = SimulatedHost()
        self.fail = True

    def checkpoint(self):
        return {"sequence": self._sequence}

    def restore(self, state):
        self._sequence = state["sequence"]

    def __call__(self, method, params):
        self._sequence += 1
        if self._sequence == self.fail_at and self.fail:
            self.fail = False
            raise BridgeError("interrupted", "deliberate interruption")
        if self._sequence in self.entries:
            saved = self.entries[self._sequence]
            assert saved[:2] == (method, params)
            return saved[2]
        result = self.subject(method, params)
        self.entries[self._sequence] = (method, params, result)
        return result


def test_real_gepa_resumes_paired_state_and_reuses_settled_callbacks(tmp_path):
    host = JournalHost()
    original = request(checkpoint={"directory": str(tmp_path), "identity": "execution"})
    with pytest.raises(BridgeError, match="deliberate"):
        optimize(original, host)
    saved = json.loads((tmp_path / "optimizer.json").read_text())
    assert saved["payload"]["session"]["evaluations"] == 1
    assert saved["payload"]["gepa"]
    result = optimize(original, host)
    assert result["provenance"]["evaluations"] == 7
    assert result["provenance"]["proposals"] == 2
    assert len(host.subject.calls) == 9
    assert optimize(original, host) == result
    assert len(host.subject.calls) == 9
    with pytest.raises(BridgeError, match="identity"):
        optimize(request(seed=42, checkpoint={"directory": str(tmp_path), "identity": "execution"}), host)
    saved = json.loads((tmp_path / "optimizer.json").read_text())
    saved["digest"] = "tampered"
    (tmp_path / "optimizer.json").write_text(json.dumps(saved))
    with pytest.raises(BridgeError, match="integrity"):
        optimize(original, host)


def test_unpaired_state_is_not_loaded_and_failed_session_is_not_saved(tmp_path):
    work = tmp_path / "gepa-work"
    work.mkdir()
    (work / "gepa_state.bin").write_bytes(b"unpaired")
    session = Session(request(checkpoint={"directory": str(tmp_path), "identity": "execution"}), SimulatedHost())
    checkpoint = Checkpoint(session)
    assert not (work / "gepa_state.bin").exists()
    session.failure = BridgeError("stopped", "stopped")
    checkpoint.on_state_saved(None)
    assert not checkpoint.path.exists()


def test_restored_seed_rejects_wrong_candidate(tmp_path):
    host = JournalHost()
    original = request(checkpoint={"directory": str(tmp_path), "identity": "execution"})
    with pytest.raises(BridgeError):
        optimize(original, host)
    session = Session(original, host)
    Checkpoint(session)
    with pytest.raises(BridgeError, match="unexpected resumed seed"):
        session.evaluate("train-case", original.components)


def test_consumed_attempt_offsets_bound_real_gepa_and_session_calls():
    host = SimulatedHost()
    result = optimize(request(recovery={"evaluations": 0, "proposals": 1}), host)
    assert result["provenance"]["proposals"] == 1
    assert result["provenance"]["evaluations"] == 4
    assert len(host.calls) == 5
    session = Session(request(recovery={"evaluations": 10, "proposals": 2}), host)
    with pytest.raises(BridgeError, match="budget"):
        session.evaluate("train-case", session.request.components)
    with pytest.raises(BridgeError, match="budget"):
        session.generate([], {})
    assert session.should_stop(None)


def test_resume_after_prior_proposal_keeps_exact_serialized_history_request(tmp_path):
    host = JournalHost(fail_at=8)
    original = request(checkpoint={"directory": str(tmp_path), "identity": "execution"})
    with pytest.raises(BridgeError, match="deliberate"):
        optimize(original, host)
    saved = json.loads((tmp_path / "optimizer.json").read_text())["payload"]["session"]
    assert saved["proposal_records"] and len(saved["results"]) >= 5
    generation = host.entries[7][1]["messages"][1]["content"]
    assert json.loads(generation)["trajectory"]["entries"]
    result = optimize(original, host)
    assert result["provenance"]["evaluations"] == 7
    assert len(host.subject.calls) == 9
    assert host.entries[7][1]["messages"][1]["content"] == generation


def test_legacy_checkpoint_identity_excludes_absent_population_fields(tmp_path):
    import hashlib

    original = request(checkpoint={"directory": str(tmp_path), "identity": "legacy"})
    checkpoint = Checkpoint(Session(original, SimulatedHost()))
    legacy_request = original.model_dump(exclude={"checkpoint", "recovery", "search", "editScope"})
    payload = {"request": legacy_request, "execution": "legacy", "versions": ["dspy3.3.1", "gepa0.1.4"]}
    expected = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"),
                                         ensure_ascii=True).encode()).hexdigest()
    assert checkpoint.identity == expected
