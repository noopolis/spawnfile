import pytest
from pydantic import ValidationError

from .fixtures_test import request
from .protocol import EvaluationResult, GenerationResult, HostResponse, OptimizeRequest, SCHEMA


@pytest.mark.parametrize("override", [
    {"testCaseIds": ["sealed"]}, {"schema": "unversioned"}, {"kind": "resume"},
    {"components": {}}, {"components": {"A": 12}}, {"components": {"": "a"}},
    {"trainCaseIds": []}, {"validationCaseIds": []},
    {"trainCaseIds": ["train-case", "train-case"]},
    {"validationCaseIds": ["v", "v"]},
    {"validationCaseIds": ["train-case"]},
    {"budget": {"maxMetricCalls": 1, "maxProposals": 0}},
    {"budget": {"maxMetricCalls": True, "maxProposals": 1}},
    {"validationCaseIds": ["v1", "v2"], "budget": {"maxMetricCalls": 1, "maxProposals": 1}},
    {"seed": -1}, {"seed": 0.5},
])
def test_rejects_invalid_or_undeclared_request_fields(override):
    with pytest.raises(ValidationError):
        request(**override)


def test_missing_seed_is_only_optimizer_randomness_default():
    values = request().model_dump(by_alias=True)
    del values["seed"]
    assert OptimizeRequest.model_validate(values).seed == 0


@pytest.mark.parametrize("score", [True, float("nan"), float("inf"), -0.1, 1.1, "1"])
def test_score_cannot_fabricate_finite_success(score):
    with pytest.raises(ValidationError):
        EvaluationResult.model_validate({"score": score, "feedback": "", "output": "", "captureId": "capture"})


@pytest.mark.parametrize("field,value", [("captureId", ""), ("feedback", None), ("output", None)])
def test_evaluation_requires_authentic_capture_and_explicit_text_fields(field, value):
    result = {"score": 0.5, "feedback": "", "output": "", "captureId": "capture"}
    result[field] = value
    with pytest.raises(ValidationError):
        EvaluationResult.model_validate(result)


@pytest.mark.parametrize("value", [
    {"text": "", "model": "m", "usage": None},
    {"text": "x", "model": "", "usage": None},
    {"text": "x", "model": "m"},
])
def test_generation_requires_text_actual_model_and_explicit_usage(value):
    with pytest.raises(ValidationError):
        GenerationResult.model_validate(value)


@pytest.mark.parametrize("outcome", [{}, {"result": {}, "error": {"code": "x", "message": "x"}}])
def test_host_response_needs_exactly_one_outcome(outcome):
    with pytest.raises(ValidationError):
        HostResponse.model_validate({"schema": SCHEMA, "kind": "response", "id": "call-1", **outcome})
