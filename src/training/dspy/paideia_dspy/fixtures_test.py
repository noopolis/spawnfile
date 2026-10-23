"""Deterministic host double; optimization itself uses installed upstream DSPy."""

import json

from .protocol import SCHEMA, OptimizeRequest


def request(**overrides):
    values = {
        "schema": SCHEMA, "kind": "optimize", "id": "experiment-1",
        "components": {"AGENTS.md": "\n  Answer carefully.\n\n", "skills/report/SKILL.md": "# Report\n"},
        "trainCaseIds": ["train-case"], "validationCaseIds": ["validation-secret-case"],
        "budget": {"maxMetricCalls": 10, "maxProposals": 2}, "seed": 7,
    }
    values.update(overrides)
    return OptimizeRequest.model_validate(values)


class SimulatedHost:
    def __init__(self):
        self.calls = []
        self.generation_count = 0

    def __call__(self, method, params):
        self.calls.append((method, params))
        if method == "generate":
            self.generation_count += 1
            data = json.loads(params["messages"][1]["content"])
            assert "validation-secret-case" not in json.dumps(params)
            text = {path: data["currentComponents"][path] + f"Revision {self.generation_count}.\n"
                    for path in data["updateOnly"]}
            return {"text": json.dumps(text), "model": "simulated-subscription", "usage": None}
        assert method == "evaluate"
        score = min(text.count("Revision ") for text in params["components"].values()) / 2
        training = params["split"] == "train"
        return {"score": score, "feedback": "Revise both text resources." if training else "",
                "output": "actual-host-output" if training else "", "captureId": f"capture-{len(self.calls)}"}
