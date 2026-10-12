"""Strict planning contract refuses malformed model payloads before native work."""
import json

import pytest
from pydantic import ValidationError

from ..fixtures_test import request
from ..protocol import BridgeError
from ..session import Session
from .variants import plan


@pytest.mark.parametrize("body", [[], {}, {"hypotheses": {}}, {"hypotheses": []},
    {"hypotheses": [None]},
    {"hypotheses": [{"strategy": "refine", "hypothesis": "why", "targetedCriteria": ["q"], "plan": "how"}]},
    {"hypotheses": [{"strategy": "rewrite", "hypothesis": "", "targetedCriteria": ["q"], "plan": "how"}]},
    {"hypotheses": [{"strategy": "rewrite", "hypothesis": "why", "targetedCriteria": [], "plan": "how"}]},
    {"hypotheses": [{"strategy": "rewrite", "hypothesis": "why", "targetedCriteria": [4], "plan": "how"}]},
])
def test_invalid_planning(body):
    session = Session(request(search={"variants": 1, "keep": 1, "rounds": 1}),
                      lambda *_: {"text": json.dumps(body), "model": "fake", "usage": None})
    with pytest.raises(BridgeError, match="planning"):
        plan(session, session.request.components, {}, ["rewrite"])
    assert session.evaluations == 0
    assert session.proposals == 1


@pytest.mark.parametrize("change,field", [
    ({"search": {"variants": 1, "keep": 2, "rounds": 1}}, "keep"),
    ({"search": {"variants": 1, "keep": 1, "rounds": 1}, "budget": {"maxMetricCalls": 1, "maxProposals": 2}}, "maxMetricCalls"),
    ({"search": {"variants": 2, "keep": 1, "rounds": 1}}, "maxProposals"),
    ({"editScope": {"other": "whole-file"}}, "editScope"),
    ({"search": {"variants": 1, "keep": 1, "rounds": 1, "unknown": True}}, "unknown"),
    ({"search": {"variants": 1, "keep": 1, "rounds": 1, "boundaries": [""]}}, "boundaries"),
    ({"search": {"variants": 1, "keep": 1, "rounds": 1, "minChange": 1.1}}, "minChange"),
])
def test_population_protocol_errors_name_fields(change, field):
    with pytest.raises(ValidationError, match=field):
        request(**change)
