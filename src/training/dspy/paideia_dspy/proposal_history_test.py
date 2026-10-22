import json

import dspy
import pytest

from .fixtures_test import request
from .optimizer import optimize
from .proposal_history import (change_ratio, classify_proposal, current_feedback,
                               history_view, normalized, policy_for)
from .protocol import BridgeError
from .reflection import ComponentProposer, proposal_parts
from .session import Session


def test_lexical_guard_recognizes_whitespace_duplicates_and_counts_changed_shingles():
    assert normalized({"a": "a\n  b"}) == {"a": "a b"}
    assert change_ratio({"a": ""}, {"a": " "}) == 0
    assert change_ratio({"a": "one two three"}, {"a": "one two three"}) == 0
    assert change_ratio({"a": "one two three"}, {"a": "four five six"}) == 1
    session = Session(request(), lambda *_: None)
    assert policy_for(session)["max_attempts"] == 2
    parent = session.request.components
    whitespace = {key: " ".join(value.split()) for key, value in parent.items()}
    assert classify_proposal(session, parent, whitespace, 0)[0] == "duplicate"
    updated = {key: value + " extra" for key, value in parent.items()}
    assert classify_proposal(session, parent, updated, 1)[0] == "below-novelty"
    session.proposal_records = [{"components": updated}]
    assert classify_proposal(session, parent, updated, 0)[0] == "duplicate"


def test_history_is_train_only_and_bounded_without_deleting_durable_raw_records():
    session = Session(request(), lambda *_: None)
    session.results = [
        {"method": "evaluate", "params": {"split": "validation", "caseId": "SEALED", "components": {"a": "SECRET"}},
         "result": {"score": 1, "feedback": "PRIVATE RUBRIC", "output": "PRIVATE OUTPUT"}},
        {"method": "generate", "params": {}, "result": {}},
        {"method": "evaluate", "params": {"split": "train", "caseId": "train", "components": {"a": "Prior prompt"}},
         "result": {"score": 0.2, "feedback": '{"failure":"missing step","subjectUsage":{"usage":{"inputTokens":42}}}', "output": "observed"}},
    ]
    view = history_view(session, policy_for(session))
    assert len(view["entries"]) == 1 and view["omittedEntries"] == 0
    assert view["entries"][0]["components"] == {"a": "Prior prompt"}
    assert view["entries"][0]["feedback"]["subjectUsage"]["usage"]["inputTokens"] == 42
    assert "SECRET" not in json.dumps(view) and "SEALED" not in json.dumps(view)
    session.results[-1]["result"]["output"] = "x" * 2000
    small = history_view(session, {**policy_for(session), "history_bytes": 1024})
    assert small["omittedEntries"] == 0
    assert small["entries"][0]["score"] == 0.2
    assert len(json.dumps(small, separators=(",", ":"))) <= 1024
    assert len(session.results[-1]["result"]["output"]) == 2000


def test_current_feedback_removes_gepa_duplicates_without_losing_output_or_reason():
    row = {"Inputs": {"case_id": "train"}, "Generated Outputs": {"score": "0.2", "feedback": "reason", "output": '{"article":"text"}'}, "Feedback": "reason"}
    assert current_feedback({"first": [row], "second": [row]})["entries"] == [
        {"caseId": "train", "score": "0.2", "measurements": {}, "feedback": "reason", "output": {"article": "text"}}]
    assert current_feedback({"first": [{}]})["entries"][0]["feedback"] == ""


def test_declared_artifact_excerpts_survive_chat_and_both_encoded_compaction_layers():
    import copy
    from .proposal_history import bounded_output, encoded
    output = {"output": {"text": "optional chat " + "😀\\\"" * 17000}, "artifacts": {
        "draft": {"status": "available", "value": {"headline": "Draft", "body": "Draft article begins " + "😀" * 20000}},
        "accepted": {"status": "available", "value": {"headline": "Accepted", "body": "Accepted article begins " + "é" * 20000}},
        "missing": {"status": "unavailable"}}}
    before = copy.deepcopy(output)
    for value in [output, bounded_output(output, 16384)]:
        current = current_feedback({"bundle": [{"Inputs": {"case_id": "train"},
            "Generated Outputs": {"score": .2, "feedback": "reason", "output": json.dumps(value)}}]})
        projected = current["entries"][0]["output"]
        assert "Draft article begins" in encoded(projected["artifacts"]["draft"]["value"])
        assert "Accepted article begins" in encoded(projected["artifacts"]["accepted"]["value"])
        assert projected["artifacts"]["missing"] == {"status": "unavailable"}
        assert len(encoded(current)) <= 65536
    assert output == before
    assert bounded_output({"artifacts": {"small": {"status": "available", "value": "article"}}}, 1024)["artifacts"]["small"]["value"] == "article"
    with pytest.raises(BridgeError, match="artifact identifiers"):
        bounded_output({"artifacts": {"name" * 1000: {"status": "unavailable"}}}, 1024)


def test_removing_per_artifact_proposal_reservation_is_killed(monkeypatch):
    from . import proposal_history
    test_declared_artifact_excerpts_survive_chat_and_both_encoded_compaction_layers()
    with monkeypatch.context() as patch:
        patch.setattr(proposal_history, "bounded_output", proposal_history.bounded_value)
        with pytest.raises((AssertionError, KeyError)):
            test_declared_artifact_excerpts_survive_chat_and_both_encoded_compaction_layers()
    test_declared_artifact_excerpts_survive_chat_and_both_encoded_compaction_layers()


class HistoryHost:
    def __init__(self, duplicates=0):
        self.calls = []
        self.generations = []
        self.duplicates = duplicates

    def __call__(self, method, params):
        self.calls.append((method, params))
        if method == "generate":
            payload = json.loads(params["messages"][1]["content"])
            assert "validation-secret-case" not in json.dumps(params)
            assert "VALIDATION SECRET" not in json.dumps(params)
            self.generations.append(payload)
            components = {key: value if len(self.generations) <= self.duplicates else value + "\nRevision " + str(len(self.generations))
                          for key, value in payload["currentComponents"].items() if key in payload["updateOnly"]}
            return {"text": json.dumps({"components": components, "hypothesis": "Explicit steps reduce omissions.",
                    "expectedImpact": [{"criterion": "completeness", "effect": "Fewer missed requirements."}]}), "model": "fixture", "usage": {"output_tokens": 12}}
        train = params["split"] == "train"
        return {"score": min(0.9, sum(text.count("Revision") for text in params["components"].values()) / 4),
                "feedback": '{"status":"fail","reason":"one omitted step"}' if train else "",
                "output": "Actual train output" if train else "", "captureId": "capture-" + str(len(self.calls))}


def test_real_gepa_repairs_duplicate_before_native_trial_and_feeds_history_to_next_proposal():
    host = HistoryHost(duplicates=1)
    result = optimize(request(proposal={"strategy": "rewrite", "min_change": 0.01},
                              budget={"maxMetricCalls": 12, "maxProposals": 3}), host)
    assert result["provenance"]["proposals"] == 3
    assert len(result["provenance"]["candidates"]) == 3
    # Duplicate caused an additional generation, never a duplicate candidate trial.
    assert result["provenance"]["evaluations"] == 7
    assert host.calls[2][0] == host.calls[3][0] == "generate"
    second = host.generations[1]["trajectory"]["entries"]
    assert any(row.get("status") == "duplicate" and row["components"] for row in second)
    third = host.generations[2]["trajectory"]["entries"]
    assert any(row.get("hypothesis") == "Explicit steps reduce omissions." for row in third)
    assert any(row["kind"] == "trial" and row["score"] > 0 for row in third)
    assert any(row.get("usage") == {"output_tokens": 12} for row in third)
    assert any(row.get("expectedImpact") == {"completeness": "Fewer missed requirements."} for row in third)


def test_exhausted_duplicate_repairs_finish_cleanly_and_restart_reuses_bookkeeping(tmp_path):
    host = HistoryHost(duplicates=99)
    original = request(proposal={"strategy": "rewrite", "max_attempts": 2},
                       checkpoint={"directory": str(tmp_path), "identity": "fixed"},
                       budget={"maxMetricCalls": 12, "maxProposals": 5})
    result = optimize(original, host)
    assert result["components"] == original.components
    assert result["provenance"]["proposals"] == 2
    assert result["provenance"]["evaluations"] == 2
    assert len(host.calls) == 4
    saved = json.loads((tmp_path / "optimizer.json").read_text())["payload"]["session"]
    assert saved["proposal_stopped"] is True
    assert all(row["components"] == original.components for row in saved["proposal_records"])
    assert saved["results"][1]["result"]["output"] == "Actual train output"
    assert saved["results"][1]["params"]["components"] == original.components
    assert [row["status"] for row in saved["proposal_records"]] == ["duplicate", "duplicate"]
    assert optimize(original, host) == result
    assert len(host.calls) == 4


@pytest.mark.parametrize("body", [None, {}, {"components": {}, "hypothesis": "", "expectedImpact": {}},
    {"components": {}, "hypothesis": "reason", "expectedImpact": {"a": 4}}])
def test_malformed_hypothesis_is_not_a_benign_duplicate(body):
    with pytest.raises(BridgeError, match="reflection"):
        proposal_parts(body, True)


def test_large_history_keeps_each_prompt_score_criterion_and_usage_before_text_excerpts():
    session = Session(request(), lambda *_: None)
    feedback = {"evaluation": {"stages": [{"id": "writing", "checks": [
        {"id": "grounding", "status": "fail", "score": .4, "reason": "first" * 50000},
        {"id": "efficiency", "status": "pass", "score": .8,
         "children": [{"id": "detail", "status": "pass", "score": .9}]}]}]},
        "subjectUsage": {"status": "complete", "usage": {"inputTokens": 123, "outputTokens": 45}}}
    session.results = [{"method": "evaluate", "params": {"split": "train", "caseId": f"case-{i}",
        "components": {"a": "Prompt " + str(i) + "漢\n" * 30000}},
        "result": {"score": 0, "feedback": json.dumps(feedback), "output": "article" * 50000}}
        for i in range(3)]
    view = history_view(session, policy_for(session))
    assert view["omittedEntries"] == 0 and len(view["entries"]) == 3
    assert len(json.dumps(view, ensure_ascii=True, separators=(",", ":"))) <= 65536
    for row in view["entries"]:
        assert row["components"]["truncated"] is True
        assert row["components"]["originalBytes"] > 65536
        assert row["components"]["excerpt"] and len(row["components"]["sha256"]) == 64
        assert row["measurements"]["criteria"][1]["id"] == "efficiency"
        assert row["measurements"]["criteria"][1]["score"] == .8
        assert row["measurements"]["subjectUsage"]["usage"]["inputTokens"] == 123
        assert row["score"] == 0 and len(row["promptId"]) == 64
    assert len(session.results[0]["params"]["components"]["a"]) > 60000
    current = current_feedback({"a": [{"Inputs": {"case_id": "train"}, "Feedback": json.dumps(feedback),
        "Generated Outputs": {"score": "0", "output": "article" * 50000}}]}, 2048)
    assert current["entries"][0]["measurements"]["criteria"][1]["score"] == .8
    assert current["entries"][0]["output"]["truncated"]
    assert len(json.dumps(current, separators=(",", ":"))) <= 2048
    tiny = history_view(session, {**policy_for(session), "history_bytes": 1024})
    assert tiny["omittedEntries"] > 0
    assert len(json.dumps(tiny, separators=(",", ":"))) <= 1024


def test_compact_context_handles_empty_rows_and_many_fields_with_explicit_excerpts():
    from .proposal_history import compact_rows
    assert current_feedback({}) == {"entries": [], "omittedEntries": 0}
    row = {"id": "one", "details": {str(i): "x" * 5000 for i in range(20)}}
    result = compact_rows([row], 1024, 1)
    assert result["entries"][0]["details"]["truncated"]
    assert len(json.dumps(result, separators=(",", ":"))) <= 1024


def test_measurements_do_not_interpret_untyped_feedback_as_evaluation_structure():
    from .proposal_history import measurements
    assert measurements("plain feedback") == {}
    for malformed in ["text", {"stages": "text"}, {"stages": [None, {"checks": "text"}]}]:
        assert measurements({"evaluation": malformed})["criteria"] == []
    assert measurements({"evaluation": {"stages": [{"checks": [None, {"id": "ok", "children": "text"}]}]}})["criteria"] == [{"stage": None, "id": "ok"}]


@pytest.mark.parametrize("limit", [1024, 2048, 65536])
def test_atomic_diagnostics_reserve_wire_space_before_prose_and_count_omissions(limit):
    import copy
    from .proposal_history import encoded
    unit = '😀\\"' * 1000
    atomic = {"failed_check_count": 83, "omitted_failed_checks": 3,
              "failed_checks": [{"template": "attribution", "unit": unit,
                                  "probability": None if i == 0 else .1} for i in range(80)]}
    feedback = {"task": "x" * 12000, "criteria": "c" * 12000, "evaluation": {"stages": [
        {"id": "writing", "checks": [{"reason": "r" * 12000,
            "children": [{"atomic": atomic}]}]}]}, "subjectUsage": None}
    session = Session(request(), lambda *_: None)
    result = {"score": 0.2, "feedback": json.dumps(feedback), "output": "Article beginning: " + "a" * 20000}
    session.results = [{"method": "evaluate", "params": {"split": "train", "caseId": "train",
                        "components": session.request.components}, "result": result}]
    before = copy.deepcopy(session.results)
    current = current_feedback({"bundle": [{"Inputs": {"case_id": "train"}, "Generated Outputs": result}]}, limit)
    history = history_view(session, {**policy_for(session), "history_bytes": limit})
    for view in [current, history]:
        assert len(encoded(view).encode()) <= limit
        assert view["omittedEntries"] == 0
        projected = view["entries"][0]["measurements"]["atomic"]
        assert projected["failed_checks"]
        assert projected["failed_checks"][0]["template"] == "attribution"
        assert unit.startswith(projected["failed_checks"][0]["unit"])
        assert projected["failed_checks"][0]["unit"]
        assert projected["failed_checks"][0]["probability"] is None
        assert projected["omitted_failed_checks"] + len(projected["failed_checks"]) == 83
        assert len(projected["failed_checks"]) <= 40
        assert len(encoded(projected)) <= 8192
    assert session.results == before


def test_atomic_projection_reads_root_nested_and_live_public_feedback_only():
    from .proposal_history import measurements, bounded_atomic, encoded
    atomic = {"failed_check_count": 3, "omitted_failed_checks": 2,
              "failed_checks": [{"template": "q", "unit": "failed", "probability": .2}]}
    feedback = {"atomic": atomic, "live": [None, {"result": {"atomic": atomic, "children": "ignored"}}],
                "evaluation": {"stages": [None, {"checks": [None, {"children": [{"atomic": atomic}]}]}]},
                "protected": "SECRET"}
    result = bounded_atomic(measurements(feedback)["atomic"], 8192)
    assert result["failed_check_count"] == 9
    assert result["omitted_failed_checks"] == 6
    assert len(result["failed_checks"]) == 3
    assert "SECRET" not in encoded(result)
    assert bounded_atomic(measurements({"atomic": atomic})["atomic"], 128)["failed_checks"]
    tiny = bounded_atomic(measurements({"atomic": atomic})["atomic"], 90)
    assert tiny["omitted_failed_checks"] == 3 and tiny["failed_checks"] == []
    assert measurements({"live": "ignored", "evaluation": {"stages": "ignored"}}).get("atomic") is None


@pytest.mark.parametrize("atomic", [None, {}, {"failed_check_count": "three"},
    {"failed_check_count": 1, "omitted_failed_checks": 0, "failed_checks": [None]},
    {"failed_check_count": 1, "omitted_failed_checks": 0, "failed_checks": [
        {"template": "q", "unit": "text", "probability": "unknown"}]},
    {"failed_check_count": 1, "omitted_failed_checks": 0, "failed_checks": [
        {"template": "q", "unit": "text"}]}])
def test_untyped_atomic_fields_do_not_turn_feedback_into_an_optimizer_error(atomic):
    from .proposal_history import measurements
    assert "atomic" not in measurements({"atomic": atomic})


@pytest.mark.parametrize("name,before,after", [
    ("measurements", "atomic = atomic_feedback(feedback)", "atomic = None"),
    ("bounded_atomic", "if len(encoded(result)) <= limit:\n            continue", "if True:\n            continue"),
    ("bounded_atomic", 'result["omitted_failed_checks"] -= 1', 'result["omitted_failed_checks"] -= 2'),
])
def test_removing_atomic_retention_wire_cap_or_omission_accounting_is_killed(monkeypatch, name, before, after):
    import inspect
    from . import proposal_history
    probe = lambda: test_atomic_diagnostics_reserve_wire_space_before_prose_and_count_omissions(1024)
    probe()
    source = inspect.getsource(getattr(proposal_history, name))
    assert source.count(before) == 1
    namespace = dict(vars(proposal_history))
    exec(source.replace(before, after), namespace)
    with monkeypatch.context() as patch:
        patch.setattr(proposal_history, name, namespace[name])
        with pytest.raises((AssertionError, KeyError)):
            probe()
    probe()
