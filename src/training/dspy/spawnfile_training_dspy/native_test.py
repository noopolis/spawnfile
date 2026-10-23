import dspy
import pytest

from .fixtures_test import SimulatedHost, request
from .native import NativePlaceholderLM, NativeProgram, NativeTrialAdapter, decode_component, encode_component, metric
from .protocol import BridgeError
from .session import Session


@pytest.mark.parametrize("text", ["", "\n    keep indentation\n\n", "漢字 👩🏽‍💻\n", "```\n  code\n```\n"])
def test_component_envelope_defeats_dspy_cleandoc_without_altering_bytes(text):
    encoded = encode_component("path/AGENTS.md", text)
    signature = dspy.Signature("case_id -> output", instructions=encoded)
    assert signature.instructions == encoded
    assert decode_component(signature.instructions) == ("path/AGENTS.md", text)


@pytest.mark.parametrize("instructions", ['[]', '{}', '{"path":1,"text":"t"}', '{"path":"p","text":null}'])
def test_malformed_component_envelope_is_rejected(instructions):
    with pytest.raises(BridgeError, match="envelope"):
        decode_component(instructions)


def test_normal_predict_records_each_component_but_runs_one_full_native_trial():
    host = SimulatedHost()
    session = Session(request(), host)
    program = NativeProgram(session)
    with dspy.context(trace=[]):
        prediction = program(case_id="train-case")
        trace = list(dspy.settings.trace)
    assert len(trace) == 2
    assert len(host.calls) == 1
    assert host.calls[0][1]["components"] == session.request.components
    assert {entry[2].captureId for entry in trace} == {prediction.captureId}
    assert [entry[1] for entry in trace] == [{"case_id": "train-case"}] * 2
    assert prediction.output == "actual-host-output"
    assert metric(None, prediction).score == 0
    assert metric(None, prediction).feedback == "Revise both text resources."
    cloned = program.deepcopy()
    cloned(case_id="train-case")
    assert session.evaluations == 2  # clone shares the same actual-attempt budget


def test_native_placeholder_cannot_fall_back_to_a_provider():
    with pytest.raises(BridgeError) as error:
        NativePlaceholderLM()("unexpected request")
    assert error.value.code == "unexpected_model_call"


@pytest.mark.parametrize("demos,config,inputs", [
    ([{"demo": "undeclared"}], {}, {"case_id": "train-case"}),
    ([], {"n": 2}, {"case_id": "train-case"}),
    ([], {}, {"case_id": "another-case"}),
])
def test_native_adapter_cannot_add_demonstrations_controls_or_extra_inputs(demos, config, inputs):
    session = Session(request(), SimulatedHost())
    program = NativeProgram(session)
    adapter = NativeTrialAdapter(session, "train-case", program.components())
    with pytest.raises(BridgeError, match="only its case reference"):
        adapter(None, config, program.component_0.signature, demos, inputs)
    assert session.evaluations == 0


def test_native_adapter_rejects_a_trace_that_disagrees_with_the_bundle():
    session = Session(request(), SimulatedHost())
    program = NativeProgram(session)
    adapter = NativeTrialAdapter(session, "train-case", {"AGENTS.md": "other"})
    with pytest.raises(BridgeError, match="does not match"):
        adapter(None, {}, program.component_0.signature, [], {"case_id": "train-case"})


def test_repeated_component_resources_latch_instead_of_fabricating_a_result():
    session = Session(request(), SimulatedHost())
    program = NativeProgram(session)
    program.component_1.signature = program.component_0.signature
    with pytest.raises(BridgeError, match="repeats"):
        program(case_id="train-case")
    assert session.failure.code == "invalid_candidate"
    assert session.evaluations == 0
