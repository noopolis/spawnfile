"""Ordinary DSPy Predict traces backed by one native trial of all components."""

import json

import dspy

from .protocol import BridgeError
from .session import Session
from .transport import parse_json


def encode_component(path: str, text: str) -> str:
    # DSPy Signature.instructions uses inspect.cleandoc. Single-line JSON avoids
    # removing Markdown indentation or the final LF from native source bytes.
    return json.dumps({"path": path, "text": text}, ensure_ascii=True, separators=(",", ":"))


def decode_component(instructions: str) -> tuple[str, str]:
    value = parse_json(instructions)
    if (not isinstance(value, dict) or set(value) != {"path", "text"}
            or not isinstance(value["path"], str) or not isinstance(value["text"], str)):
        raise BridgeError("invalid_candidate", "component instruction envelope is malformed")
    return value["path"], value["text"]


class NativePlaceholderLM(dspy.BaseLM):
    """Satisfies Predict's type contract; the native adapter never invokes an LM."""

    forward_contract = "typed_lm"

    def __init__(self):
        super().__init__("paideia/native-host", cache=False, num_retries=0)

    def forward(self, request):
        raise BridgeError("unexpected_model_call", "native prediction must use the host trial adapter")


class NativeTrialAdapter(dspy.Adapter):
    def __init__(self, session: Session, case_id: str, components: dict[str, str]):
        super().__init__()
        self.session, self.case_id, self.components = session, case_id, components
        self.result = None

    def __call__(self, lm, lm_kwargs, signature, demos, inputs):
        if demos or lm_kwargs or inputs != {"case_id": self.case_id}:
            raise BridgeError("unsupported_predictor", "native predictor accepts only its case reference")
        path, text = decode_component(signature.instructions)
        if self.components.get(path) != text:
            raise BridgeError("invalid_candidate", "predictor instruction does not match the native bundle")
        if self.result is None:
            self.result = self.session.evaluate(self.case_id, self.components)
        # Each component's trace cites the same genuine whole-program evaluation.
        # This is component exposure, not a claim of per-file causal attribution.
        return [self.result.model_dump()]


class NativeProgram(dspy.Module):
    def __init__(self, session: Session):
        super().__init__()
        self._session = session
        for index, (path, text) in enumerate(sorted(session.request.components.items())):
            signature = dspy.Signature(
                "case_id: str -> output: str, score: float, feedback: str, captureId: str",
                instructions=encode_component(path, text),
            )
            setattr(self, f"component_{index}", dspy.Predict(signature))

    def components(self):
        pairs = [decode_component(predictor.signature.instructions)
                 for _, predictor in self.named_predictors()]
        if len(dict(pairs)) != len(pairs):
            raise BridgeError("invalid_candidate", "candidate repeats a component resource")
        return dict(pairs)

    def forward(self, case_id: str):
        try:
            adapter = NativeTrialAdapter(self._session, case_id, self.components())
            with dspy.context(adapter=adapter, lm=NativePlaceholderLM()):
                for _, predictor in self.named_predictors():
                    prediction = predictor(case_id=case_id)
            return prediction
        except Exception as error:
            # DSPy's evaluator deliberately converts ordinary Exceptions to scores.
            # A latched bridge error prevents that from becoming a successful run.
            raise self._session.latch(error) from error


def metric(gold, prediction, trace=None, pred_name=None, pred_trace=None):
    return dspy.Prediction(score=prediction.score, feedback=prediction.feedback)
