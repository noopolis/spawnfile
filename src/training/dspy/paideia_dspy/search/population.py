"""Deterministic round search reconstructed from ordered host callback responses."""
import math
import random
from typing import Protocol

from .behavior_change import behavior_change, hypothesis_similarity
from .boundaries import boundary_violation, compile_boundaries
from ..proposal_history import change_ratio, normalized, policy_for, prompt_id
from ..protocol import BridgeError
from .selection import select
from ..session import Session
from .variants import plan, realize


class Evaluator(Protocol):
    """P6 may supply concurrency; return results in request order, never completion order."""

    def evaluate_many(self, requests: list[dict]) -> list:
        ...


class SequentialEvaluator:
    def __init__(self, session):
        self.session = session

    def evaluate_many(self, requests):
        return [self.session.evaluate(row["caseId"], row["components"]) for row in requests]


class Population:
    def __init__(self, session, evaluator):
        self.session, self.evaluator = session, evaluator
        self.request, self.search = session.request, session.request.search
        self.candidates, self.rounds, self.hypotheses = [], [], []
        self.seen = [self.request.components]
        self.train = {}
        self.policy = policy_for(session)
        self.boundaries = compile_boundaries(self.search.boundaries, self.request.components)

    def metric_room(self, count):
        return self.session.evaluations + count <= self.request.budget.maxMetricCalls

    def proposal_room(self, count):
        return self.session.proposals + count <= self.request.budget.maxProposals

    def evaluate(self, components, cases):
        return self.evaluator.evaluate_many([{"caseId": case, "components": components} for case in cases])

    def validate(self, components, parent):
        discovery = self.session.evaluations if self.candidates else 0
        results = self.evaluate(components, self.request.validationCaseIds)
        scores = {case: result.score for case, result in zip(self.request.validationCaseIds, results, strict=True)}
        self.candidates.append({"components": components, "parents": [parent],
                                "perCaseScores": scores, "validationScore": sum(scores.values()) / len(scores),
                                "discoveryEvaluations": discovery})
        return len(self.candidates) - 1

    def feedback(self, index):
        if index not in self.train:
            results = self.evaluate(self.candidates[index]["components"], self.request.trainCaseIds)
            self.train[index] = dict(zip(self.request.trainCaseIds, results, strict=True))
        return self.train[index]

    def reject_reason(self, parent, components, hypothesis, siblings, planned=None):
        if set(components) != set(parent) or any(not isinstance(text, str) for text in components.values()):
            return "editable-components", None, None
        if boundary_violation(self.boundaries, components):
            return "hard-boundary", None, None
        behavioral, lexical = behavior_change(parent, components), change_ratio(parent, components)
        if normalized(components) in [normalized(other) for other in self.seen]:
            return "duplicate", behavioral, lexical
        if behavioral < self.search.minChange:
            return "below-min-change", behavioral, lexical
        if any(behavior_change(other, components) < self.search.minChange for other in siblings):
            return "sibling-similarity", behavioral, lexical
        if any(behavior_change(other, components) == 0 for other in self.seen):
            return "duplicate", behavioral, lexical
        if any(hypothesis_similarity(current, previous) >= self.search.hypothesisSimilarity
               for current in ([hypothesis, planned] if planned is not None else [hypothesis])
               for previous in self.hypotheses):
            return "hypothesis-duplicate", behavioral, lexical
        return None, behavioral, lexical

    def slot(self, slot, parent_index, planned, feedback, siblings):
        parent = self.candidates[parent_index]["components"]
        row = {"slot": slot, "parent": parent_index, "strategy": planned["strategy"],
               "hypothesis": planned["hypothesis"], "targetedCriteria": planned["targetedCriteria"],
               "behavioralChange": None, "lexicalChange": None, "status": "empty",
               "rejectionReason": "budget", "candidateIndex": None, "attempts": []}
        slot_hypotheses = []
        slot_components = []
        for _ in range(self.policy["max_attempts"]):
            if not self.proposal_room(1) or not self.metric_room(len(self.request.validationCaseIds)):
                break
            components, hypothesis, impact = realize(self.session, parent, feedback, planned,
                                                     row["rejectionReason"] if row["attempts"] else None)
            reason, behavioral, lexical = self.reject_reason(
                parent, components, hypothesis, siblings, planned["hypothesis"] if not row["attempts"] else None)
            if reason != "editable-components":
                slot_components.append(components)
            if reason is None and set(impact) != set(planned["targetedCriteria"]):
                reason = "targeted-criteria"
            slot_hypotheses.append(hypothesis)
            row.update(hypothesis=hypothesis, behavioralChange=behavioral, lexicalChange=lexical,
                       status="rejected" if reason else "accepted", rejectionReason=reason)
            row["attempts"].append({key: row[key] for key in
                                    ["behavioralChange", "lexicalChange", "status", "rejectionReason"]})
            self.session.proposal_records.append({
                "sequence": len(self.session.results), "kind": "proposal", "parentId": prompt_id(parent),
                "promptId": prompt_id(components), "components": components, "hypothesis": hypothesis,
                "expectedImpact": impact, "plannedHypothesis": planned["hypothesis"],
                "status": row["status"], "rejectionReason": reason,
                "behavioralChange": behavioral, "lexicalChange": lexical,
                "usage": self.session.generations[-1]["usage"],
            })
            if reason is None:
                row["candidateIndex"] = self.validate(components, parent_index)
                siblings.append(components)
                break
        # Repairs may reuse this slot's content; every attempted valid bundle
        # remains reserved against other slots and later rounds, even if rejected.
        self.seen.extend(slot_components)
        self.hypotheses.extend([*slot_hypotheses, planned["hypothesis"]])
        return row

    def run(self):
        self.validate(self.request.components, None)
        self.feedback(0)
        kept, stale, best = [0], 0, self.candidates[0]["validationScore"]
        self.rounds.append({"round": 0, "parents": [], "variants": [], "kept": kept[:]})
        reason = "rounds"
        rng = random.Random(self.request.seed)
        for number in range(1, self.search.rounds + 1):
            parents = kept[:]
            rng.shuffle(parents)
            # Reserve uncached feedback as well as the packet's minimum planning,
            # realization and complete validation pass before starting any parent.
            first_cost = (0 if parents[0] in self.train else len(self.request.trainCaseIds))
            if not self.proposal_room(2) or not self.metric_room(first_cost + len(self.request.validationCaseIds)):
                reason = "budget"
                break
            strategies = ["rewrite"] * math.ceil(self.search.variants * self.search.rewriteShare)
            strategies += ["refine"] * (self.search.variants - len(strategies))
            assignments = [(slot, parents[slot % len(parents)], strategy) for slot, strategy in enumerate(strategies)]
            rows, siblings, accepted = [], [], []
            for parent in parents:
                slots = [(slot, strategy) for slot, index, strategy in assignments if index == parent]
                cost = 0 if parent in self.train else len(self.request.trainCaseIds)
                if not self.proposal_room(2) or not self.metric_room(cost + len(self.request.validationCaseIds)):
                    for slot, strategy in slots:
                        rows.append({"slot": slot, "parent": parent, "strategy": strategy, "hypothesis": "",
                                     "targetedCriteria": [], "behavioralChange": None, "lexicalChange": None,
                                     "status": "empty", "rejectionReason": "budget", "candidateIndex": None, "attempts": []})
                    continue
                feedback = self.feedback(parent)
                plans = plan(self.session, self.candidates[parent]["components"], feedback,
                             [strategy for _, strategy in slots])
                for (slot, _), planned in zip(slots, plans, strict=True):
                    row = self.slot(slot, parent, planned, feedback, siblings)
                    rows.append(row)
                    if row["candidateIndex"] is not None:
                        accepted.append(row["candidateIndex"])
            kept = select(self.candidates, kept + accepted, self.search.keep, self.search.selection)
            self.rounds.append({"round": number, "parents": parents, "variants": sorted(rows, key=lambda row: row["slot"]),
                                "kept": kept[:]})
            score = max(candidate["validationScore"] for candidate in self.candidates)
            stale = stale + 1 if score == best else 0
            best = score
            if any(row["status"] == "empty" for row in rows):
                reason = "budget"
                break
            if number < self.search.rounds and self.search.patience is not None and stale >= self.search.patience:
                reason = "patience"
                break
        winner = max(range(len(self.candidates)), key=lambda index: (self.candidates[index]["validationScore"], -index))
        return {"components": self.candidates[winner]["components"], "provenance": {
            "optimizer": "paideia.population", "dspyVersion": "3.3.1", "gepaVersion": "0.1.4",
            "seed": self.request.seed, "evaluations": self.session.evaluations, "proposals": self.session.proposals,
            "selectedCandidateIndex": winner, "candidates": self.candidates, "rounds": self.rounds,
            "stopReason": reason, "editScope": self.request.editScope or {path: "whole-file" for path in self.request.components},
            "changeEvidence": "bridge-reported-v2",
            "captures": self.session.captures,
            "generations": [{**generation, "text": response["result"]["text"]}
                            for generation, response in zip(self.session.generations,
                                [row for row in self.session.results if row["method"] == "generate"], strict=True)],
        }}


def optimize_population(request, host, evaluator_factory=SequentialEvaluator):
    # Host journal replay reconstructs state; never read/write GEPA pickle here.
    if request.checkpoint and request.checkpoint.fork:
        raise BridgeError("unsupported_checkpoint", "population checkpoint forks are unsupported")
    if request.recovery and (request.recovery.evaluations or request.recovery.proposals):
        raise BridgeError("unsupported_checkpoint", "population cannot replay uncertain or failed callback attempts; use a new run")
    session = Session(request, host)
    return Population(session, evaluator_factory(session)).run()
