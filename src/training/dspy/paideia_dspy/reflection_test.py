import json

import dspy
import pytest

from .fixtures_test import request
from .native import decode_component, encode_component
from .protocol import BridgeError
from .reflection import ComponentProposer, SubscriptionLM, parse_component_response
from .session import Session


def native_request():
    return dspy.LMRequest.from_call(model="host-route", messages=[{"role": "user", "content": "reflect"}])


def test_typed_lm_retains_observed_model_and_unknown_usage():
    calls = []

    def host(method, params):
        calls.append((method, params))
        return {"text": "replacement", "model": "observed-native-model", "usage": None}

    session = Session(request(), host)
    lm = SubscriptionLM(session)
    typed = lm(request=native_request())
    assert typed.model == "observed-native-model"
    assert typed.usage is None
    assert lm(messages=[{"role": "user", "content": "second"}]) == ["replacement"]
    assert calls[0] == ("generate", {"purpose": "reflection", "messages": [
        {"role": "user", "content": "reflect"}], "options": {}})


@pytest.mark.parametrize("mutation", [
    lambda r: r.metadata.update({"unsupported": True}),
    lambda r: r.tools.append(object()),
    lambda r: setattr(r.messages[0], "role", "tool"),
    lambda r: setattr(r.messages[0], "name", "worker"),
    lambda r: r.messages[0].metadata.update({"unsupported": True}),
    lambda r: r.messages[0].parts[0].metadata.update({"unsupported": True}),
    lambda r: setattr(r.messages[0].parts[0], "type", "image"),
    lambda r: setattr(r.config, "temperature", 0.5),
    lambda r: r.config.extensions.update({"seed": 7}),
])
def test_unsupported_inference_features_fail_before_generation(mutation):
    calls = []
    session = Session(request(), lambda *args: calls.append(args))
    lm_request = native_request()
    mutation(lm_request)
    with pytest.raises(BridgeError) as error:
        SubscriptionLM(session).forward(lm_request)
    assert error.value.code == "unsupported_control"
    assert calls == []
    assert session.failure is error.value


def proposal_input():
    return {"component_0": encode_component("AGENTS.md", "Original\n")}, {
        "component_0": [{"Inputs": {"case_id": "train"}, "Feedback": "Improve."}],
    }, ["component_0"]


@pytest.mark.parametrize("fenced", [False, True])
def test_public_proposer_preserves_json_text_and_does_not_request_model_controls(fenced):
    replacement = "\n  Revised café\n```text\nkeep this skill example\n```\n\n"
    response = json.dumps({"AGENTS.md": replacement})
    if fenced:
        response = "```json\n" + response + "\n```"
    session = Session(request(), lambda method, params: {
        "text": response, "model": "observed", "usage": None,
    })
    with dspy.context(lm=SubscriptionLM(session)):
        result = ComponentProposer(session)(*proposal_input())
    assert decode_component(result["component_0"]) == ("AGENTS.md", replacement)
    assert session.proposals == 1


@pytest.mark.parametrize("text", ['{}', '{"extra":"x"}', '{"AGENTS.md":5}', '```json\n{}\n```'])
def test_malformed_proposal_latches_and_cannot_trigger_gepa_retry_generation(text):
    session = Session(request(), lambda *args: {"text": text, "model": "m", "usage": None})
    proposer = ComponentProposer(session)
    with dspy.context(lm=SubscriptionLM(session)):
        for _ in range(2):
            with pytest.raises(BridgeError):
                proposer(*proposal_input())
    assert session.proposals == 1
    assert session.failure is not None


def test_missing_subscription_route_never_uses_a_dspy_default_lm():
    session = Session(request(), lambda *args: pytest.fail("unexpected callback"))
    with dspy.context(lm=None), pytest.raises(BridgeError) as error:
        ComponentProposer(session)(*proposal_input())
    assert error.value.code == "missing_inference"


@pytest.mark.parametrize("text", [
    'Before\n```json\n{"AGENTS.md":"x"}\n```',
    '```json\n{"AGENTS.md":"x"}\n```\nAfter',
    '```json\n{"AGENTS.md":"x"}\n```\n```json\n{"AGENTS.md":"y"}\n```',
    '```\n{"AGENTS.md":"x"}\n```',
    '```JSON\n{"AGENTS.md":"x"}\n```',
    '```json {"AGENTS.md":"x"}```',
    '```json\n{"AGENTS.md":"x"}\n',
    '```json\n{"AGENTS.md":"x","AGENTS.md":"y"}\n```',
    '```json\n{"AGENTS.md":NaN}\n```',
    '```json\n{"AGENTS.md":Infinity}\n```',
])
def test_model_envelope_never_extracts_arbitrary_json_or_weakens_strict_json(text):
    with pytest.raises(BridgeError) as error:
        parse_component_response(text)
    assert error.value.code == "invalid_json"


@pytest.mark.parametrize("text", [
    '```json\n{"AGENTS.md":"x","SOUL.md":"changed locked text"}\n```',
    '```json\n{"AGENTS.md":1e999}\n```',
    '```json\n["replacement"]\n```',
])
def test_fenced_proposal_keeps_exact_resource_and_text_guards_without_retry(text):
    session = Session(request(), lambda *args: {"text": text, "model": "m", "usage": None})
    proposer = ComponentProposer(session)
    with dspy.context(lm=SubscriptionLM(session)):
        for _ in range(2):
            with pytest.raises(BridgeError):
                proposer(*proposal_input())
    assert session.proposals == 1


def test_proposer_requests_exact_selected_resource_schema_through_real_typed_lm():
    calls = []

    def host(method, params):
        calls.append(params)
        return {"text": '{"AGENTS.md":"Updated\\n"}', "model": "observed", "usage": None}

    session = Session(request(), host)
    with dspy.context(lm=SubscriptionLM(session)):
        ComponentProposer(session)(*proposal_input())
    assert calls[0]["options"] == {"responseSchema": {
        "type": "object", "properties": {"AGENTS.md": {"type": "string"}},
        "required": ["AGENTS.md"], "additionalProperties": False,
    }}


@pytest.mark.parametrize("schema", [None, [], "object", 1])
def test_typed_lm_rejects_nonobject_schema_before_host_call(schema):
    calls = []
    session = Session(request(), lambda *args: calls.append(args))
    with pytest.raises(BridgeError) as error:
        SubscriptionLM(session)(messages=[{"role": "user", "content": "reflect"}],
                                extensions={"responseSchema": schema})
    assert error.value.code == "unsupported_control"
    assert calls == []
