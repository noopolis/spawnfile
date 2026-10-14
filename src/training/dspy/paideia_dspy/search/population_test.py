"""Scripted host tests spend no real inference or native trials."""
import json

import pytest

from ..fixtures_test import request
from ..optimizer import optimize
from ..protocol import BridgeError


HYPOTHESES = [
    "Prioritize verified sources to prevent unsupported attribution",
    "Schedule counterexample inspection before composing causal explanations",
    "Quantify uncertain estimates with explicit numerical intervals",
    "Separate conflicting testimony into independently assessed claims",
    "Remove repetitive preambles and arrange conclusions by relevance",
    "Check chronological dependencies using a dated event ledger",
    "Classify missing observations and abstain from unsupported verdicts",
    "Compare alternative interpretations through falsifiable predictions",
]
TEXTS = [
    "# Evidence workflow\nFirst collect three independent sources.\nNever state claims without attribution.\nOnly then compose conclusions.",
    "# Analysis\nList competing explanations.\nBefore drafting, inspect counterexamples.\nReject causes contradicted by observations.",
    "# Estimates\nAlways compute numeric uncertainty intervals.\nIf measurements disagree, report both bounds.\nDo not imply precision.",
    "# Claims\nClassify testimony by origin.\nEvaluate every claim independently.\nUse explicit confidence categories.",
    "# Compose\nStart with the most relevant finding.\nRemove all redundant introductory paragraphs.\nFinish with supporting examples.",
    "# Timeline\nBuild a dated event ledger.\nAfter sorting events, verify dependencies.\nFlag reversed causal order.",
    "# Observations\nMark absent measurements as unknown.\nAbstain unless sufficient evidence exists.\nRecord every missing input.",
    "# Predictions\nCompare alternative interpretations.\nDerive falsifiable predictions.\nPrefer explanations surviving independent tests.",
]


def population_request(**overrides):
    values = {"components": {"guide": "Answer carefully."},
              "budget": {"maxMetricCalls": 100, "maxProposals": 100},
              "search": {"variants": 2, "keep": 1, "rounds": 2}}
    return request(**{**values, **overrides})


class Host:
    def __init__(self, texts=None, hypotheses=None, score=None):
        self.calls, self.plans = [], []
        self.texts, self.hypotheses = texts or TEXTS, hypotheses or HYPOTHESES
        self.realizations, self.planned = 0, 0
        self.score = score or (lambda components: 0.1 if components["guide"] == "Answer carefully." else 0.8)

    def __call__(self, method, params):
        self.calls.append((method, params))
        if method == "evaluate":
            training = params["split"] == "train"
            return {"score": self.score(params["components"]), "captureId": f"capture-{len(self.calls)}",
                    "feedback": '{"criteria":["quality"]}' if training else "", "output": "sample" if training else ""}
        payload = json.loads(params["messages"][1]["content"])
        if payload["phase"] == "planning":
            rows = []
            for strategy in payload["strategies"]:
                rows.append({"strategy": strategy, "hypothesis": self.hypotheses[self.planned % len(self.hypotheses)],
                             "targetedCriteria": ["quality"], "plan": "Reorganize the workflow using the supplied evidence"})
                self.planned += 1
            self.plans.append(rows)
            body = {"hypotheses": rows}
        else:
            index = self.realizations
            body = {"components": {"guide": self.texts[index % len(self.texts)]},
                    "hypothesis": self.hypotheses[index % len(self.hypotheses)],
                    "expectedImpact": [{"criterion": "quality", "effect": "Improve evidence quality"}]}
            self.realizations += 1
        return {"text": json.dumps(body), "model": "scripted", "usage": None}


def test_rounds_slots_keep_seed_drop_determinism_and_train_cache():
    first, second = Host(), Host()
    result = optimize(population_request(), first)
    assert result == optimize(population_request(), second)
    assert first.calls == second.calls
    p = result["provenance"]
    assert len(p["rounds"]) == 3
    assert [len(row["variants"]) for row in p["rounds"]] == [0, 2, 2]
    assert all(len(row["kept"]) <= 1 for row in p["rounds"])
    assert 0 not in p["rounds"][1]["kept"]
    assert len(p["candidates"]) == 5
    assert p["proposals"] == 6  # one planning + two realization calls per round
    evaluations = [params for method, params in first.calls if method == "evaluate"]
    assert len(evaluations) == 10  # complete train and validation for every candidate
    assert len({(row["caseId"], json.dumps(row["components"])) for row in evaluations}) == 10
    for candidate in p["candidates"]:
        assert sorted(row["split"] for row in evaluations if row["components"] == candidate["components"]) == ["train", "validation"]
    assert p["editScope"] == {"guide": "whole-file"}


def test_formatting_rejected_structural_accepted_without_spending_trial():
    host = Host(texts=["**Answer** carefully.", TEXTS[0]])
    result = optimize(population_request(search={"variants": 1, "keep": 1, "rounds": 1}), host)
    row = result["provenance"]["rounds"][1]["variants"][0]
    assert row["status"] == "accepted"
    assert row["attempts"][0]["rejectionReason"] == "below-min-change"
    assert row["attempts"][0]["behavioralChange"] == 0
    assert row["attempts"][1]["behavioralChange"] >= 0.08
    assert result["provenance"]["evaluations"] == 4


def test_duplicate_hypotheses_never_evaluated():
    host = Host(hypotheses=[HYPOTHESES[0]])
    result = optimize(population_request(search={"variants": 2, "keep": 1, "rounds": 1},
                                         proposal={"max_attempts": 1}), host)
    rows = result["provenance"]["rounds"][1]["variants"]
    assert [row["status"] for row in rows] == ["accepted", "rejected"]
    assert rows[1]["rejectionReason"] == "hypothesis-duplicate"
    assert result["provenance"]["evaluations"] == 4


@pytest.mark.parametrize("share,expected", [(0, ["refine"] * 3), (0.5, ["rewrite", "rewrite", "refine"]), (1, ["rewrite"] * 3)])
def test_strategy_mix_boundaries_scope_and_train_only_prompts(share, expected):
    host = Host()
    boundaries = []
    result = optimize(population_request(search={"variants": 3, "keep": 2, "rounds": 1,
                                                "rewriteShare": share, "boundaries": boundaries},
                                         editScope={"guide": ["Workflow"]}), host)
    assert [row["strategy"] for row in host.plans[0]] == expected
    assert result["provenance"]["editScope"] == {"guide": ["Workflow"]}
    for method, params in host.calls:
        if method == "generate":
            payload = json.loads(params["messages"][1]["content"])
            assert payload["boundaries"] == boundaries
            assert payload["changePolicy"] == {"minChange": 0.08, "hypothesisSimilarity": 0.6}
            assert "validation-secret-case" not in json.dumps(params)
            assert "ONLY non-negotiable constraints" in params["messages"][0]["content"]
            assert "preserv" not in params["messages"][0]["content"].lower()


def test_metric_cap_and_proposal_cap_stop_cleanly():
    for budget, evaluations, proposals in [({"maxMetricCalls": 2, "maxProposals": 3}, 2, 0),
                                          ({"maxMetricCalls": 100, "maxProposals": 3}, 6, 3),
                                          ({"maxMetricCalls": 3, "maxProposals": 100}, 2, 0)]:
        result = optimize(population_request(budget=budget), Host())["provenance"]
        assert result["stopReason"] == "budget"
        assert result["evaluations"] == evaluations
        assert result["proposals"] == proposals


def test_no_improvement_patience():
    result = optimize(population_request(search={"variants": 1, "keep": 1, "rounds": 5, "patience": 1}),
                      Host(score=lambda _: 0.5))["provenance"]
    assert result["stopReason"] == "patience"
    assert len(result["rounds"]) == 2


def test_duplicate_and_sibling_gates():
    texts = ["Answer carefully.", TEXTS[0], TEXTS[0].replace("# Evidence workflow", "## Evidence workflow")]
    result = optimize(population_request(search={"variants": 2, "keep": 1, "rounds": 1},
                                         proposal={"max_attempts": 2}), Host(texts=texts))["provenance"]
    rows = result["rounds"][1]["variants"]
    assert rows[0]["attempts"][0]["rejectionReason"] == "duplicate"
    assert rows[1]["attempts"][0]["rejectionReason"] == "sibling-similarity"
    assert result["evaluations"] == 4


def test_component_set_and_targeted_criteria_rejection():
    for field, replacement, reason in [("components", {"locked": "changed"}, "editable-components"),
                                       ("expectedImpact", [{"criterion": "invented", "effect": "effect"}], "targeted-criteria")]:
        host = Host()
        def callback(method, params):
            reply = host(method, params)
            if method == "generate" and json.loads(params["messages"][1]["content"])["phase"] == "realization":
                body = json.loads(reply["text"])
                body[field] = replacement
                reply["text"] = json.dumps(body)
            return reply
        result = optimize(population_request(proposal={"max_attempts": 1}), callback)["provenance"]
        assert result["evaluations"] == 2
        assert result["rounds"][1]["variants"][0]["rejectionReason"] == reason


def test_population_checkpoint_replays_settled_callbacks_and_refuses_uncertainty(tmp_path):
    start = population_request(checkpoint={"directory": str(tmp_path), "identity": "stable"})
    expected_host = Host()
    expected = optimize(start, expected_host)
    original, journal = Host(), []
    def interrupted(method, params):
        reply = original(method, params)
        journal.append((method, params, reply))
        if len(journal) == 3:
            raise BridgeError("interrupted", "stopped after host journal settled planning")
        return reply
    with pytest.raises(BridgeError, match="stopped"):
        optimize(start, interrupted)
    count = 0
    def replay(method, params):
        nonlocal count
        count += 1
        if count <= len(journal):
            recorded_method, recorded_params, reply = journal[count - 1]
            assert (method, params) == (recorded_method, recorded_params)
            return reply
        return original(method, params)
    actual = optimize(start, replay)
    assert actual == expected
    assert original.calls == expected_host.calls  # no extra model or trial spend
    assert not list(tmp_path.iterdir())  # no Python-side pickle or checkpoint
    with pytest.raises(BridgeError, match="uncertain"):
        optimize(population_request(recovery={"evaluations": 1}), Host())
    with pytest.raises(BridgeError, match="forks"):
        optimize(population_request(checkpoint={"directory": str(tmp_path), "identity": "child", "fork": {
            "directory": str(tmp_path / "parent"), "identity": "parent", "id": "old", "digest": "sha256:" + "0" * 64}}), Host())


def test_partial_round_marks_unfunded_parent_slots():
    result = optimize(population_request(search={"variants": 2, "keep": 2, "rounds": 2},
        budget={"maxMetricCalls": 100, "maxProposals": 5}), Host())["provenance"]
    rows = result["rounds"][2]["variants"]
    assert len(rows) == 2
    assert sum(row["status"] == "empty" for row in rows) == 1
    assert result["stopReason"] == "budget"


def test_duplicate_plans_cannot_evade_dedupe_by_changing_realization_words():
    host = Host()
    def callback(method, params):
        reply = host(method, params)
        if method == "generate" and json.loads(params["messages"][1]["content"])["phase"] == "planning":
            body = json.loads(reply["text"])
            for row in body["hypotheses"]:
                row["hypothesis"] = HYPOTHESES[0]
            reply["text"] = json.dumps(body)
        return reply
    result = optimize(population_request(search={"variants": 2, "keep": 1, "rounds": 1},
                                         proposal={"max_attempts": 1}), callback)["provenance"]
    assert result["rounds"][1]["variants"][1]["rejectionReason"] == "hypothesis-duplicate"
    assert result["evaluations"] == 4


@pytest.mark.parametrize('before,after', [
    ('- Always verify sources before publishing', '- **Always** verify sources\n  before publishing'),
    ('Publishing rules\n================\n\nVerify sources.', '# Publishing rules\n\nVerify sources.'),
])
def test_logical_formatting_rejected_without_evaluations(before, after):
    host = Host(texts=[after])
    result = optimize(population_request(components={'guide': before}, proposal={'max_attempts': 1},
                                        search={'variants': 1, 'keep': 1, 'rounds': 1}), host)['provenance']
    row = result['rounds'][1]['variants'][0]
    assert row['status'] == 'rejected'
    assert row['rejectionReason'] == 'below-min-change'
    assert row['behavioralChange'] == 0
    assert result['evaluations'] == 2
    assert len([call for call in host.calls if call[0] == 'evaluate']) == 2


@pytest.mark.parametrize('after', [
    'Verify sources; cite evidence.',
    'Cite evidence; verify sources.',
    '**Cite evidence**； verify sources.',
    'Verify sources. Cite evidence. Verify sources. Cite evidence.',
    '# Rules\nVerify sources.\n## Citations\nCite evidence.',
    'New rules\n=========\nVerify sources. Cite evidence.',
])
def test_punctuation_only_edit_never_launches_candidate_evaluation(after):
    host = Host(texts=[after])
    result = optimize(population_request(components={'guide': 'Verify sources. Cite evidence.'},
        proposal={'max_attempts': 1}, search={'variants': 1, 'keep': 1, 'rounds': 1}), host)['provenance']
    row = result['rounds'][1]['variants'][0]
    assert row['rejectionReason'] == 'below-min-change'
    assert row['behavioralChange'] == 0
    assert len(result['candidates']) == 1
    assert result['evaluations'] == 2
    assert len([call for call in host.calls if call[0] == 'evaluate']) == 2


@pytest.mark.parametrize('repair', [True, False])
def test_metadata_repair_reuses_content_only_within_its_slot(repair):
    host = Host(texts=[TEXTS[0]], hypotheses=HYPOTHESES)

    def callback(method, params):
        reply = host(method, params)
        if method == 'generate' and json.loads(params['messages'][1]['content'])['phase'] == 'realization':
            body = json.loads(reply['text'])
            # Keep the same content and hypothesis for the first slot's repair.
            if host.realizations <= 2:
                body['hypothesis'] = HYPOTHESES[0]
            if host.realizations == 1 or (host.realizations == 2 and not repair):
                body['expectedImpact'] = [{'criterion': 'incorrect', 'effect': 'Improve evidence quality'}]
            reply['text'] = json.dumps(body)
        return reply

    result = optimize(population_request(proposal={'max_attempts': 2},
        search={'variants': 2, 'keep': 1, 'rounds': 2}), callback)['provenance']
    first, second = result['rounds'][1]['variants']
    assert first['attempts'][0]['rejectionReason'] == 'targeted-criteria'
    assert first['attempts'][1]['rejectionReason'] == (None if repair else 'targeted-criteria')
    assert first['status'] == ('accepted' if repair else 'rejected')
    assert all(attempt['rejectionReason'] == 'duplicate' for attempt in second['attempts'])
    assert all(attempt['rejectionReason'] == 'duplicate'
               for row in result['rounds'][2]['variants'] for attempt in row['attempts'])
    assert len(result['candidates']) == (2 if repair else 1)
    validation = [params for method, params in host.calls if method == 'evaluate' and params['split'] != 'train']
    assert len(validation) == (2 if repair else 1)


def test_similar_hypothesis_can_repair_min_change_rejection():
    host = Host(texts=['**Answer** carefully.', TEXTS[0]],
                hypotheses=[HYPOTHESES[0], HYPOTHESES[0] + ' explicitly'])
    result = optimize(population_request(search={'variants': 1, 'keep': 1, 'rounds': 1}), host)['provenance']
    row = result['rounds'][1]['variants'][0]
    assert row['attempts'][0]['rejectionReason'] == 'below-min-change'
    assert row['attempts'][1]['status'] == 'accepted'
    assert row['hypothesis'] == HYPOTHESES[0] + ' explicitly'
    assert result['evaluations'] == 4


@pytest.mark.parametrize('before,after', [
    ('If evidence is missing, never publish; otherwise proceed.',
     'If evidence is missing, proceed; otherwise never publish.'),
    ('Never publish unverified claims and always quote primary sources.',
     'Always publish unverified claims and never quote primary sources.'),
])
def test_directive_reversal_passes_default_floor(before, after):
    host = Host(texts=[after])
    result = optimize(population_request(components={'guide': before},
                                        search={'variants': 1, 'keep': 1, 'rounds': 1}), host)['provenance']
    row = result['rounds'][1]['variants'][0]
    assert row['status'] == 'accepted'
    assert row['behavioralChange'] > 0.08
    assert result['candidates'][1]['components'] == {'guide': after}
    assert result['evaluations'] == 4
    assert len([call for call in host.calls if call[0] == 'evaluate']) == 4


@pytest.mark.parametrize('floor', [0, 0.08])
@pytest.mark.parametrize('seed,proposals', [
    ('Answer carefully.', [TEXTS[0], '**Answer** carefully.']),
    ('Verify sources. Cite evidence.', [TEXTS[0], 'Cite evidence; verify sources.']),
    ('Answer carefully.', [TEXTS[0], TEXTS[1], TEXTS[0].replace('First', '**First**')]),
])
def test_formatted_history_is_rejected_after_original_leaves_population(floor, seed, proposals):
    # Strictly increasing scores make the historical candidate neither parent
    # nor sibling when its formatted copy returns.
    scores = {seed: 0.1, TEXTS[0]: 0.5, TEXTS[1]: 0.8}
    host = Host(texts=proposals, score=lambda components: scores.get(components['guide'], 1.0))
    result = optimize(population_request(components={'guide': seed}, proposal={'max_attempts': 1},
        search={'variants': 1, 'keep': 1, 'rounds': len(proposals), 'minChange': floor}), host)['provenance']
    row = result['rounds'][-1]['variants'][0]
    assert result['rounds'][-2]['kept'] == [len(proposals) - 1]
    assert row['behavioralChange'] > 0.08
    assert row['rejectionReason'] == 'duplicate'
    assert row['status'] == 'rejected'
    assert len(result['candidates']) == len(proposals)
    evaluations = [params for method, params in host.calls if method == 'evaluate']
    assert result['evaluations'] == len(evaluations) == 2 * len(proposals)
    assert all(params['components']['guide'] != proposals[-1] for params in evaluations)


def test_formatted_rejected_attempt_stays_reserved_in_later_rounds():
    host = Host(texts=[TEXTS[0], TEXTS[0].replace('First', '**First**')])

    def callback(method, params):
        reply = host(method, params)
        if method == 'generate' and host.realizations == 1:
            body = json.loads(reply['text'])
            if 'components' in body:
                body['expectedImpact'] = [{'criterion': 'incorrect', 'effect': 'Wrong target'}]
                reply['text'] = json.dumps(body)
        return reply

    result = optimize(population_request(proposal={'max_attempts': 1},
        search={'variants': 1, 'keep': 1, 'rounds': 2}), callback)['provenance']
    assert result['rounds'][1]['variants'][0]['rejectionReason'] == 'targeted-criteria'
    assert result['rounds'][2]['variants'][0]['rejectionReason'] == 'duplicate'
    assert len(result['candidates']) == 1
    assert result['evaluations'] == len([call for call in host.calls if call[0] == 'evaluate']) == 2


def test_evaluator_factory_receives_ordered_batches_and_preserves_result_identity():
    from .population import optimize_population
    batches = []

    class Evaluator:
        def __init__(self, session):
            self.session = session

        def evaluate_many(self, requests):
            batches.append(requests)
            return [self.session.evaluate(row['caseId'], row['components']) for row in requests]

    start = population_request(validationCaseIds=['validation-a', 'validation-b'])
    expected = optimize(start, Host())
    assert optimize_population(start, Host(), evaluator_factory=Evaluator) == expected
    assert len(batches) == 10
    assert [row['caseId'] for row in batches[0]] == ['validation-a', 'validation-b']
    assert [row['caseId'] for row in batches[1]] == start.trainCaseIds
