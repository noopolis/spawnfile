"""Pair upstream GEPA state with the host session and upstream sampler state.

Only evaluator-owned directories are accepted by the TypeScript caller. Pickle
is an upstream checkpoint format, never an agent-supplied dataset artifact.
"""
import base64
import hashlib
import json
import os
import random
from collections import Counter
from pathlib import Path

from gepa.strategies.batch_sampler import EpochShuffledBatchSampler

from .protocol import BridgeError, EvaluationResult


def _bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def _tuples(value):
    return tuple(_tuples(item) for item in value) if isinstance(value, list) else value


class Checkpoint:
    def __init__(self, session):
        self.session = session
        self.directory = Path(session.request.checkpoint.directory)
        self.work = self.directory / "gepa-work"
        self.work.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = self.directory / "optimizer.json"
        self.sampler = EpochShuffledBatchSampler(1, random.Random(session.request.seed))
        self.identity = hashlib.sha256(_bytes({
            "request": session.request.model_dump(exclude={"checkpoint", "recovery"}),
            "execution": session.request.checkpoint.identity, "versions": ["dspy3.3.1", "gepa0.1.4"],
        })).hexdigest()
        if self.path.exists():
            self._restore()
        else:
            # Unpaired upstream files can only be an interrupted save. Never load them.
            (self.work / "gepa_state.bin").unlink(missing_ok=True)

    def _restore(self):
        envelope = json.loads(self.path.read_text())
        saved = envelope["payload"]
        if (saved["identity"] != self.identity
                or hashlib.sha256(_bytes(saved)).hexdigest() != envelope["digest"]):
            raise BridgeError("checkpoint_mismatch", "optimizer checkpoint integrity or identity mismatch")
        (self.work / "gepa_state.bin").write_bytes(base64.b64decode(saved["gepa"], validate=True))
        state = saved["session"]
        for name in ["evaluations", "proposals", "captures", "generations", "results", "proposal_records", "proposal_stopped"]:
            setattr(self.session, name, state[name])
        self.session.seed_replay = {
            item["params"]["caseId"]: EvaluationResult.model_validate(item["result"])
            for item in self.session.results[:len(self.session.request.validationCaseIds)]
        }
        # JSONL callback numbering is the durable call identity, not a new attempt.
        if hasattr(self.session.host, "_sequence"):
            self.session.host._sequence = len(self.session.results)
        sample = saved["sampler"]
        for key, value in sample.items():
            if key == "rng":
                self.sampler.rng.setstate(_tuples(value))
            elif key == "id_freqs":
                self.sampler.id_freqs = Counter(dict(value))
            else:
                setattr(self.sampler, key, value)

    def on_state_saved(self, event):
        if self.session.failure is not None:
            return
        state = self.work / "gepa_state.bin"
        sample = {key: value for key, value in vars(self.sampler).items() if key not in {"rng", "id_freqs"}}
        sample["rng"] = self.sampler.rng.getstate()
        sample["id_freqs"] = list(self.sampler.id_freqs.items())
        payload = {
            "identity": self.identity, "gepa": base64.b64encode(state.read_bytes()).decode(),
            "session": {name: getattr(self.session, name) for name in
                        ["evaluations", "proposals", "captures", "generations", "results", "proposal_records", "proposal_stopped"]},
            "sampler": sample,
        }
        temporary = self.path.with_suffix(".tmp")
        with temporary.open("wb") as output:
            output.write(_bytes({"payload": payload, "digest": hashlib.sha256(_bytes(payload)).hexdigest()}))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, self.path)
        directory = os.open(self.directory, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def kwargs(self):
        return {"batch_sampler": self.sampler, "callbacks": [self]}
