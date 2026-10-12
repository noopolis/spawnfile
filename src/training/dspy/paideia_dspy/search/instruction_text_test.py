import pytest

from ..optimizer import optimize
from .behavior_change import behavior_change, instruction_units
from .population_test import Host, population_request

BASE = 'Read evidence. Write a report.'
PADDING = [
    'Read evidence.\n<!-- unique incidental note -->\nWrite a report.',
    'Read evidence. <!-- unique\nincidental note --> Write a report.',
    '<!-- first -->Read evidence. <!-- second -->Write a report.<!-- last -->',
    '---\ntitle: Unique incidental note\nrevision: 32\n---\n' + BASE,
    '\ufeff---\ntitle: Another label\n...\n' + BASE,
    'Read<!-- incidental\ncomment -->\nevidence. Write a report.',
    BASE + '\n[reference]: https://example.invalid "unique incidental title"',
]


@pytest.mark.parametrize('after', PADDING)
def test_metadata_has_zero_instruction_change(after):
    assert instruction_units(after) == instruction_units(BASE)
    assert behavior_change({'guide': BASE}, {'guide': after}) == 0
    assert behavior_change({'guide': after}, {'guide': BASE}) == 0


@pytest.mark.parametrize('after', PADDING)
@pytest.mark.parametrize('floor', [0, 0.08])
def test_metadata_only_proposal_never_reaches_evaluation(after, floor):
    host = Host(texts=[after])
    result = optimize(population_request(components={'guide': BASE}, proposal={'max_attempts': 1},
        search={'variants': 1, 'keep': 1, 'rounds': 1, 'minChange': floor}), host)['provenance']
    row = result['rounds'][1]['variants'][0]
    assert row['behavioralChange'] == 0
    assert row['rejectionReason'] == ('below-min-change' if floor else 'duplicate')
    assert row['status'] == 'rejected'
    assert len(result['candidates']) == 1
    assert result['evaluations'] == 2
    assert all(params['components']['guide'] == BASE for method, params in host.calls if method == 'evaluate')


def test_comments_do_not_split_wrapped_conditional_rules():
    before = 'If sources agree,\nwrite a report.'
    after = 'If sources agree,\n<!-- label\ncontinued -->\nwrite a report.'
    assert instruction_units(before) == instruction_units(after)


def test_literal_fenced_content_and_unclosed_front_matter_are_not_metadata():
    for before, after in [
        ('```html\n<!-- schema v1 -->\n```', '```html\n<!-- schema v2 -->\n```'),
        ('~~~\n[ref]: original\n~~~', '~~~\n[ref]: replacement\n~~~'),
        ('---\nRead evidence.', '---\nWrite a report.'),
    ]:
        assert behavior_change({'guide': before}, {'guide': after}) > 0.08


def test_padding_does_not_dilute_real_changes():
    after = 'Never read evidence. Write a report.'
    expected = behavior_change({'guide': BASE}, {'guide': after})
    assert behavior_change({'guide': BASE}, {'guide': after + '\n<!-- note -->' * 100}) == expected
