import copy

import pytest

from .fixtures_test import SimulatedHost, request
from .protocol import BridgeError
from .session import Session


def test_shared_session_survives_candidate_deepcopy_and_reserves_budget():
    session = Session(request(budget={"maxMetricCalls": 4, "maxProposals": 1}), SimulatedHost())
    assert copy.deepcopy(session) is session
    assert session.should_stop(None) is False
    result = session.evaluate("train-case", session.request.components)
    assert result.captureId == "capture-1"
    assert session.should_stop(None) is False
    session.evaluate("train-case", session.request.components)
    assert session.should_stop(None) is True


@pytest.mark.parametrize("case,components,code", [
    ("train-case", {"unexpected": "text"}, "invalid_candidate"),
    ("sealed-test-case", None, "invalid_case"),
])
def test_host_never_sees_undeclared_components_or_cases(case, components, code):
    host = SimulatedHost()
    session = Session(request(), host)
    with pytest.raises(BridgeError) as error:
        session.evaluate(case, session.request.components if components is None else components)
    assert error.value.code == code
    assert host.calls == []


def test_native_attempt_limit_counts_repeated_trials():
    session = Session(request(budget={"maxMetricCalls": 1, "maxProposals": 1}), SimulatedHost())
    session.evaluate("train-case", session.request.components)
    with pytest.raises(BridgeError, match="evaluation attempt budget"):
        session.evaluate("train-case", session.request.components)
    assert session.evaluations == 1


@pytest.mark.parametrize("bad_field", ["feedback", "output"])
def test_validation_text_is_a_latched_split_violation(bad_field):
    result = {"score": 0.5, "feedback": "", "output": "", "captureId": "capture"}
    result[bad_field] = "validation answer leakage"
    session = Session(request(), lambda *args: result)
    with pytest.raises(BridgeError) as error:
        session.evaluate("validation-secret-case", session.request.components)
    assert error.value.code == "split_violation"
    assert session.evaluations == 1
    assert session.should_stop(None)
    with pytest.raises(BridgeError):
        session.healthy()


@pytest.mark.parametrize("failure,code", [
    (BridgeError("auth_missing", "login absent"), "auth_missing"),
    (RuntimeError("raw external diagnostic"), "host_error"),
    ({"score": 1}, "invalid_response"),
])
def test_failed_attempt_is_counted_once_and_latched(failure, code):
    calls = []

    def host(*args):
        calls.append(args)
        if isinstance(failure, Exception):
            raise failure
        return failure

    session = Session(request(), host)
    for _ in range(2):
        with pytest.raises(BridgeError) as error:
            session.evaluate("train-case", session.request.components)
        assert error.value.code == code
    assert session.evaluations == 1
    assert len(calls) == 1


def test_proposal_limit_and_unsupported_controls_never_call_host_again():
    host_calls = []

    def host(*args):
        host_calls.append(args)
        return {"text": "{}", "model": "observed", "usage": {"input_tokens": 12}}

    session = Session(request(budget={"maxMetricCalls": 4, "maxProposals": 1}), host)
    with pytest.raises(BridgeError, match="generation controls"):
        session.generate([], {"temperature": 0.4})
    assert session.proposals == 0
    result = session.generate([{"role": "user", "content": "reflect"}], {})
    assert result.usage == {"input_tokens": 12}
    with pytest.raises(BridgeError, match="proposal attempt budget"):
        session.generate([], {})
    assert len(host_calls) == 1
    assert session.should_stop(None)


def test_unknown_predictor_error_latches_without_replacing_first_failure():
    session = Session(request(), SimulatedHost())
    first = session.latch(RuntimeError("hidden"))
    assert first.code == "optimizer_error"
    assert session.latch(BridgeError("second", "ignored")) is first
