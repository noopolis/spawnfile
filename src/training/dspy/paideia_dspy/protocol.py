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


class CheckpointFork(StrictModel):
    directory: TextId
    identity: TextId
    id: TextId
    digest: Annotated[str, Field(pattern=r"^sha256:[0-9a-f]{64}$")]


class Checkpoint(StrictModel):
    directory: TextId
    identity: TextId
    fork: CheckpointFork | None = None


class Recovery(StrictModel):
    evaluations: Annotated[int, Field(ge=0)] = 0
    proposals: Annotated[int, Field(ge=0)] = 0


class ProposalPolicy(StrictModel):
    strategy: Literal["refine", "rewrite"] | None = None
    min_change: Annotated[float, Field(ge=0, le=1)] | None = None
    max_attempts: Annotated[int, Field(ge=1, le=5)] | None = None
    history_entries: Annotated[int, Field(ge=1, le=100)] | None = None
    history_bytes: Annotated[int, Field(ge=1024, le=262144)] | None = None


class Search(StrictModel):
    variants: Annotated[int, Field(ge=1, le=1000)]
    keep: Annotated[int, Field(ge=1, le=1000)]
    rounds: Annotated[int, Field(ge=1, le=2**53 - 1)]
    selection: Literal["pareto", "top-k"] = "pareto"
    rewriteShare: Annotated[float, Field(ge=0, le=1)] = 0.5
    minChange: Annotated[float, Field(ge=0, le=1)] = 0.08
    hypothesisSimilarity: Annotated[float, Field(ge=0, le=1)] = 0.6
    patience: Annotated[int, Field(ge=1, le=2**53 - 1)] | None = None
    boundaries: Annotated[list[Annotated[str, Field(min_length=1, max_length=500)]], Field(max_length=50)] = []

    @model_validator(mode="after")
    def population_size(self):
        if self.keep > self.variants:
            raise ValueError("search.keep must not exceed search.variants")
        if self.patience is None:
            self.patience = self.rounds
        return self


class OptimizeRequest(StrictModel):
    schema_version: Literal["paideia.dspy.v1"] = Field(alias="schema")
    kind: Literal["optimize"]
    id: TextId
    components: Annotated[dict[TextId, ComponentText], Field(min_length=1, max_length=64)]
    trainCaseIds: Annotated[list[TextId], Field(min_length=1, max_length=10000)]
    validationCaseIds: Annotated[list[TextId], Field(min_length=1, max_length=10000)]
    budget: Budget
    proposal: ProposalPolicy | None = None
    search: Search | None = None
    editScope: dict[TextId, Literal["whole-file"] | Annotated[list[TextId], Field(min_length=1)]] | None = None
    checkpoint: Checkpoint | None = None
    recovery: Recovery | None = None
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
        if self.search:
            if self.budget.maxMetricCalls < len(validation) + len(train):
                raise ValueError("budget.maxMetricCalls must cover seed validation and train cases")
            if self.budget.maxProposals < self.search.keep + self.search.variants:
                raise ValueError("budget.maxProposals must cover search.keep + search.variants")
        if self.editScope is not None and set(self.editScope) != set(self.components):
            raise ValueError("editScope must describe exactly the editable components")
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
    modelBasis: Literal["provider-reported", "requested-assumption"] = "provider-reported"


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
