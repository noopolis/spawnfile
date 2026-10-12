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
from .transport import parse_json


def _bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def _tuples(value):
    return tuple(_tuples(item) for item in value) if isinstance(value, list) else value


class Checkpoint:
    def __init__(self, session):
        self.session = session
        self.directory = Path(session.request.checkpoint.directory)
        self.work = self.directory / "gepa-work"
        self.path = self.directory / "optimizer.json"
        self.sampler = EpochShuffledBatchSampler(1, random.Random(session.request.seed))
        self.identity = self._identity(session.request.id, session.request.checkpoint.identity)
        self.lineage = None
        fork = session.request.checkpoint.fork
        if fork:
            parent, child = Path(fork.directory).resolve(), self.directory.resolve()
            if (parent == child or parent in child.parents or child in parent.parents
                    or fork.id == session.request.id):
                raise BridgeError("checkpoint_mismatch", "checkpoint fork requires a distinct experiment and disjoint directory")
        if self.path.exists():
            self._restore()
        elif fork:
            self._import(fork)
        else:
            self.work.mkdir(mode=0o700, parents=True, exist_ok=True)
            # Unpaired upstream files can only be an interrupted save. Never load them.
            (self.work / "gepa_state.bin").unlink(missing_ok=True)

    def _identity(self, experiment_id, execution):
        request = self.session.request.model_dump(exclude={"checkpoint", "recovery"})
        # Preserve legacy checkpoint identity bytes when population fields are absent.
        for field in ("search", "editScope"):
            if request[field] is None:
                del request[field]
        request["id"] = experiment_id
        return hashlib.sha256(_bytes({
            "request": request, "execution": execution, "versions": ["dspy3.3.1", "gepa0.1.4"],
        })).hexdigest()

    def _read(self, path, identity, digest=None):
        try:
            data = path.read_bytes()
            if digest and "sha256:" + hashlib.sha256(data).hexdigest() != digest:
                raise ValueError("parent bytes changed")
            envelope = parse_json(data)
            saved = envelope["payload"]
            if (saved["identity"] != identity
                    or hashlib.sha256(_bytes(saved)).hexdigest() != envelope["digest"]):
                raise ValueError("payload identity or digest changed")
            # Decode and validate before creating a child checkpoint or host work.
            base64.b64decode(saved["gepa"], validate=True)
            return saved
        except (OSError, ValueError, TypeError, KeyError, BridgeError) as error:
            raise BridgeError("checkpoint_mismatch", "optimizer checkpoint integrity or identity mismatch") from error

    def _import(self, fork):
        saved = self._read(Path(fork.directory) / "optimizer.json",
                           self._identity(fork.id, fork.identity), fork.digest)
        self.lineage = {"parent": fork.model_dump(), "previous": saved.get("lineage")}
        self._apply(saved)
        # Persist the new identity and lineage before even replaying a host callback.
        self.on_state_saved(None)

    def _restore(self):
        saved = self._read(self.path, self.identity)
        self.lineage = saved.get("lineage")
        fork = self.session.request.checkpoint.fork
        if ((self.lineage is None) != (fork is None)
                or (fork and self.lineage.get("parent") != fork.model_dump())):
            raise BridgeError("checkpoint_mismatch", "optimizer checkpoint fork lineage mismatch")
        self._apply(saved)

    def _apply(self, saved):
        self.work.mkdir(mode=0o700, parents=True, exist_ok=True)
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
        if self.lineage is not None:
            payload["lineage"] = self.lineage
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
