"""Boundary admission is enforced without asking a proposer for permission."""
import json
import pytest

from ..optimizer import optimize
from ..protocol import BridgeError
from .boundaries import boundary_violation, compile_boundaries
from .population_test import Host, population_request, TEXTS


@pytest.mark.parametrize('declaration', [
    'preserve ["guide"]\n', 'Never publish unverified claims.', 'require-text ["guide"]',
    'require-text ["guide", ""]', 'require-text ["missing", "rule"]',
    'preserve ["guide", "extra"]', 'preserve [null]', 'preserve [', 'preserve [invalid]',
    'preserve {"component":"guide"}', 'require-text ["guide", 1]',
])
def test_unenforceable_boundaries_fail_closed_before_any_host_call(declaration):
    host = Host()
    start = population_request(search={'variants': 1, 'keep': 1, 'rounds': 1,
                                      'boundaries': [declaration]})
    with pytest.raises(BridgeError, match='Unsupported hard boundary') as error:
        optimize(start, host)
    assert error.value.code == 'unsupported_boundaries'
    assert host.calls == []


@pytest.mark.parametrize('boundary', [
    'require-text ["guide", "Absent rule."]', 'forbid-text ["guide", "Answer carefully."]',
])
def test_invalid_seed_never_reaches_host(boundary):
    host = Host()
    with pytest.raises(BridgeError, match='Seed violates'):
        optimize(population_request(search={'variants': 1, 'keep': 1, 'rounds': 1,
                                           'boundaries': [boundary]}), host)
    assert host.calls == []


@pytest.mark.parametrize('boundary,after,accepted', [
    ('require-text ["guide", "Answer carefully."]', TEXTS[0] + '\nAnswer carefully.', True),
    ('require-text ["guide", "Answer carefully."]', TEXTS[0], False),
    ('forbid-text ["guide", "Invent claims."]', TEXTS[0], True),
    ('forbid-text ["guide", "Invent claims."]', TEXTS[0] + '\nInvent claims.', False),
    ('preserve ["guide"]', TEXTS[0], False),
])
def test_boundary_admission_precedes_evaluation(boundary, after, accepted):
    host = Host(texts=[after])
    result = optimize(population_request(proposal={'max_attempts': 1},
        search={'variants': 1, 'keep': 1, 'rounds': 1, 'boundaries': [boundary]}), host)['provenance']
    row = result['rounds'][1]['variants'][0]
    assert row['status'] == ('accepted' if accepted else 'rejected')
    assert row['rejectionReason'] == (None if accepted else 'hard-boundary')
    assert result['evaluations'] == (4 if accepted else 2)
    assert len(result['candidates']) == (2 if accepted else 1)
    evaluations = [params for method, params in host.calls if method == 'evaluate']
    assert len(evaluations) == result['evaluations']
    assert any(params['components']['guide'] == after for params in evaluations) == accepted
    assert all(json.loads(params['messages'][1]['content'])['boundaries'] == [boundary]
               for method, params in host.calls if method == 'generate')


def test_preserved_component_allows_other_components_to_change_and_repairs_violations():
    host = Host(texts=[TEXTS[0], TEXTS[1]])
    seed = {'guide': 'Answer carefully.', 'contract': 'Use schema v1.\n'}

    def callback(method, params):
        response = host(method, params)
        if method == 'generate' and json.loads(params['messages'][1]['content'])['phase'] == 'realization':
            body = json.loads(response['text'])
            body['components']['contract'] = 'Use schema v2.' if host.realizations == 1 else seed['contract']
            response['text'] = json.dumps(body)
        return response

    result = optimize(population_request(components=seed,
        search={'variants': 1, 'keep': 1, 'rounds': 1, 'boundaries': ['preserve ["contract"]']}),
        callback)['provenance']
    row = result['rounds'][1]['variants'][0]
    assert [attempt['rejectionReason'] for attempt in row['attempts']] == ['hard-boundary', None]
    assert result['candidates'][1]['components'] == {'guide': TEXTS[1], 'contract': seed['contract']}
    assert result['evaluations'] == 4
    assert all(params['components']['contract'] == seed['contract']
               for method, params in host.calls if method == 'evaluate')


def test_rules_are_conjunctive_exact_text_and_component_scoped():
    seed = {'guide': 'Required rule.', 'other': 'unchanged'}
    rules = compile_boundaries(['require-text ["guide", "Required rule."]',
                                'forbid-text ["guide", "Forbidden."]', 'preserve ["other"]'], seed)
    assert not boundary_violation(rules, seed)
    for after in [{}, {**seed, 'guide': 'required rule.'},
                  {**seed, 'guide': 'Required rule. Forbidden.'}, {**seed, 'other': 'changed'}]:
        assert boundary_violation(rules, after)
