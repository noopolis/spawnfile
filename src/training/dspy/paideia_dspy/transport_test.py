import io
import json

import pytest

from .protocol import BridgeError, SCHEMA
from .transport import JsonlHost, parse_json, read_message, write_message


@pytest.mark.parametrize("text", ['{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}', '{broken'])
def test_json_rejects_duplicate_nonfinite_or_malformed_content(text):
    with pytest.raises(BridgeError) as error:
        parse_json(text)
    assert error.value.code == "invalid_json"


@pytest.mark.parametrize("frame,code", [
    (b"", "host_disconnected"), (b"{}", "invalid_frame"),
    (b"\xff\n", "invalid_json"), (b'"abcdefghijklmnop"\n', "invalid_frame"),
])
def test_bounded_strict_utf8_framing(frame, code, monkeypatch):
    monkeypatch.setattr("paideia_dspy.transport.MAX_LINE_BYTES", 16)
    with pytest.raises(BridgeError) as error:
        read_message(io.BytesIO(frame))
    assert error.value.code == code


def test_writer_encodes_newlines_and_unicode_in_one_protocol_line(monkeypatch):
    writer = io.StringIO()
    write_message(writer, {"text": "你好\nnext"})
    assert writer.getvalue().count("\n") == 1
    assert read_message(io.BytesIO(writer.getvalue().encode())) == {"text": "你好\nnext"}
    monkeypatch.setattr("paideia_dspy.transport.MAX_LINE_BYTES", 4)
    with pytest.raises(BridgeError, match="size limit"):
        write_message(writer, {"a": "large"})


def response(**outcome):
    return {"schema": SCHEMA, "kind": "response", "id": "call-1", **outcome}


def test_serial_host_correlates_ids_and_preserves_structured_params():
    replies = [response(result={"one": 1}), {**response(result={"two": 2}), "id": "call-2"}]
    reader = io.BytesIO(("\n".join(json.dumps(r) for r in replies) + "\n").encode())
    writer = io.StringIO()
    host = JsonlHost(reader, writer)
    assert host("evaluate", {"components": {"A": "first\nsecond"}}) == {"one": 1}
    assert host("generate", {"options": {}}) == {"two": 2}
    sent = [json.loads(line) for line in writer.getvalue().splitlines()]
    assert [message["id"] for message in sent] == ["call-1", "call-2"]
    assert sent[0]["params"]["components"]["A"] == "first\nsecond"


@pytest.mark.parametrize("reply,code", [
    ({**response(result={}), "id": "wrong"}, "invalid_response"),
    ({**response(result={}), "surprise": True}, "invalid_response"),
    (response(error={"code": "quota_exhausted", "message": "no quota"}), "quota_exhausted"),
])
def test_host_error_or_mismatched_reply_is_not_a_success(reply, code):
    host = JsonlHost(io.BytesIO((json.dumps(reply) + "\n").encode()), io.StringIO())
    with pytest.raises(BridgeError) as error:
        host("generate", {})
    assert error.value.code == code
