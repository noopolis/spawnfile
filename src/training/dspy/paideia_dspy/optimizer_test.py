import pytest

from .fixtures_test import SimulatedHost, request
from .optimizer import optimize
from .protocol import BridgeError


@pytest.mark.parametrize("fenced", [False, True])
def test_real_dspy_gepa_optimizes_two_files_through_host_callbacks(fenced):
    host = SimulatedHost()

    def generate_envelope(method, params):
        response = host(method, params)
        if fenced and method == "generate":
            response = {**response, "text": "```json\n" + response["text"] + "\n```"}
        return response
    original = request()
    result = optimize(original, generate_envelope)
    provenance = result["provenance"]
    assert provenance["optimizer"] == "dspy.GEPA"
    assert provenance["dspyVersion"] == "3.3.1"
    assert provenance["gepaVersion"] == "0.1.4"
    assert provenance["proposals"] == 2
    assert provenance["evaluations"] == 7
    assert provenance["selectedCandidateIndex"] == 2
    assert [candidate["validationScore"] for candidate in provenance["candidates"]] == [0, 0.5, 1]
    assert provenance["candidates"][0]["components"] == original.components
    assert provenance["candidates"][2]["parents"] == [1]
    assert len(provenance["captures"]) == 7
    assert provenance["generations"] == [{"model": "simulated-subscription", "usage": None}] * 2
    for path, text in original.components.items():
        assert result["components"][path] == text + "Revision 1.\nRevision 2.\n"
    evaluations = [params for method, params in host.calls if method == "evaluate"]
    assert len(evaluations) == 7  # one complete trial, not one trial per component
    assert evaluations[0]["components"] == original.components
    assert evaluations[-1]["components"] == result["components"]


def test_reserves_full_validation_and_never_exceeds_native_attempt_budget():
    host = SimulatedHost()
    result = optimize(request(budget={"maxMetricCalls": 3, "maxProposals": 2}), host)
    assert result["provenance"]["evaluations"] == 1
    assert result["provenance"]["proposals"] == 0
    assert len(result["provenance"]["candidates"]) == 1


def test_host_failure_cannot_become_a_successful_zero_score_candidate():
    calls = []

    def failing_host(method, params):
        calls.append(method)
        raise BridgeError("quota_exhausted", "subscription quota exhausted")

    with pytest.raises(BridgeError, match="quota exhausted") as error:
        optimize(request(), failing_host)
    assert error.value.code == "quota_exhausted"
    assert calls == ["evaluate"]


def test_installed_release_mismatch_fails_before_any_callback(monkeypatch):
    monkeypatch.setattr("paideia_dspy.optimizer.version", lambda _name: "other")
    host = SimulatedHost()
    with pytest.raises(BridgeError, match="pinned"):
        optimize(request(), host)
    assert host.calls == []
