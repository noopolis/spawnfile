"""Host callbacks, exact component boundaries and observed attempt budgets."""

import threading
from collections.abc import Callable

from pydantic import ValidationError

from .protocol import BridgeError, EvaluationResult, GenerationResult, OptimizeRequest


class Session:
    def __init__(self, request: OptimizeRequest, host: Callable[[str, dict], dict]):
        self.request, self.host = request, host
        self.extra_evaluations = request.recovery.evaluations if request.recovery else 0
        self.extra_proposals = request.recovery.proposals if request.recovery else 0
        self.evaluations = 0
        self.proposals = 0
        self.captures: list[dict] = []
        self.generations: list[dict] = []
        self.results: list[dict] = []
        self.proposal_records: list[dict] = []
        self.proposal_stopped = False
        self.seed_replay: dict[str, EvaluationResult] = {}
        self.failure: BridgeError | None = None
        self._lock = threading.RLock()

    def __deepcopy__(self, _memo):
        # DSPy clones candidate programs; their callbacks share one budget/transport.
        return self

    def latch(self, error: Exception):
        if self.failure is None:
            self.failure = error if isinstance(error, BridgeError) else BridgeError(
                "optimizer_error", "native predictor failed before producing authentic evidence",
            )
        return self.failure

    def healthy(self):
        if self.failure is not None:
            raise self.failure

    def _call(self, method, params, response_type):
        self.healthy()
        try:
            result = response_type.model_validate(self.host(method, params))
            self.results.append({"method": method, "params": params, "result": result.model_dump()})
            return result
        except Exception as error:
            self.failure = error if isinstance(error, BridgeError) else BridgeError(
                "invalid_response" if isinstance(error, ValidationError) else "host_error",
                "host callback failed or returned an invalid result",
            )
            raise self.failure from error

    def evaluate(self, case_id: str, components: dict[str, str]):
        with self._lock:
            self.healthy()
            if set(components) != set(self.request.components):
                raise BridgeError("invalid_candidate", "candidate changed the declared component set")
            if case_id in self.request.trainCaseIds:
                split = "train"
            elif case_id in self.request.validationCaseIds:
                split = "validation"
            else:
                raise BridgeError("invalid_case", "optimizer requested a case outside its declared splits")
            if self.seed_replay:
                if split != "validation" or components != self.request.components or case_id not in self.seed_replay:
                    raise BridgeError("checkpoint_mismatch", "unexpected resumed seed evaluation")
                return self.seed_replay.pop(case_id)
            if self.evaluations + self.extra_evaluations >= self.request.budget.maxMetricCalls:
                raise BridgeError("budget_exhausted", "native evaluation attempt budget exhausted")
            # A failed host attempt consumes a slot; repeated feedback calls do not.
            self.evaluations += 1
            result = self._call("evaluate", {
                "caseId": case_id, "split": split, "components": components,
            }, EvaluationResult)
            if split == "validation" and (result.feedback or result.output):
                self.failure = BridgeError("split_violation", "validation returns scalar selection evidence only")
                raise self.failure
            self.captures.append({"caseId": case_id, "split": split, "captureId": result.captureId})
            return result

    def generate(self, messages: list[dict], options: dict):
        with self._lock:
            self.healthy()
            if (set(options) - {"responseSchema"}
                    or ("responseSchema" in options and not isinstance(options["responseSchema"], dict))):
                raise BridgeError("unsupported_control", "this bridge supports only a JSON response schema, not sampling generation controls")
            if self.proposals + self.extra_proposals >= self.request.budget.maxProposals:
                raise BridgeError("budget_exhausted", "reflection proposal attempt budget exhausted")
            self.proposals += 1
            result = self._call("generate", {
                "purpose": "reflection", "messages": messages, "options": options,
            }, GenerationResult)
            generation = {"model": result.model, "usage": result.usage}
            if "modelBasis" in result.model_fields_set:
                generation["modelBasis"] = result.modelBasis
            self.generations.append(generation)
            return result

    def should_stop(self, _state):
        # GEPA checks at iteration boundaries. Reserve one training baseline, one
        # proposal trial and a complete validation pass before starting an iteration.
        return (self.failure is not None or self.proposal_stopped
                or self.proposals + self.extra_proposals >= self.request.budget.maxProposals
                or self.evaluations + self.extra_evaluations + 2 + len(self.request.validationCaseIds)
                > self.request.budget.maxMetricCalls)
