"""Strict wire types; the host retains resource and experiment policy."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

SCHEMA = "paideia.dspy.v1"
MAX_LINE_BYTES = 4 * 1024 * 1024
TextId = Annotated[str, Field(min_length=1, max_length=4096)]
ComponentText = Annotated[str, Field(max_length=1024 * 1024)]


class BridgeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class Budget(StrictModel):
    maxMetricCalls: Annotated[int, Field(ge=1, le=10000)]
    maxProposals: Annotated[int, Field(ge=1, le=1000)]


class OptimizeRequest(StrictModel):
    schema_version: Literal["paideia.dspy.v1"] = Field(alias="schema")
    kind: Literal["optimize"]
    id: TextId
    components: Annotated[dict[TextId, ComponentText], Field(min_length=1, max_length=64)]
    trainCaseIds: Annotated[list[TextId], Field(min_length=1, max_length=10000)]
    validationCaseIds: Annotated[list[TextId], Field(min_length=1, max_length=10000)]
    budget: Budget
    seed: Annotated[int, Field(ge=0, le=2**32 - 1)] = 0

    @model_validator(mode="after")
    def validate_case_sets(self):
        train, validation = set(self.trainCaseIds), set(self.validationCaseIds)
        if len(train) != len(self.trainCaseIds) or len(validation) != len(self.validationCaseIds):
            raise ValueError("case IDs must be unique within each split")
        if train & validation:
            raise ValueError("training and validation case IDs must be disjoint")
        if self.budget.maxMetricCalls < len(validation):
            raise ValueError("budget must cover the complete baseline validation")
        return self


class EvaluationResult(StrictModel):
    score: Annotated[float, Field(ge=0, le=1)]
    feedback: str
    output: str
    captureId: TextId


class GenerationResult(StrictModel):
    text: Annotated[str, Field(min_length=1)]
    model: TextId
    usage: dict | None


class HostError(StrictModel):
    code: TextId
    message: str


class HostResponse(StrictModel):
    schema_version: Literal["paideia.dspy.v1"] = Field(alias="schema")
    kind: Literal["response"]
    id: TextId
    result: dict | None = None
    error: HostError | None = None

    @model_validator(mode="after")
    def exactly_one_outcome(self):
        if (self.result is None) == (self.error is None):
            raise ValueError("host response needs exactly one result or error")
        return self
