import pytest

from .behavior_change import behavior_change, hypothesis_similarity, instruction_units


def change(before, after):
    return behavior_change({"instructions": before}, {"instructions": after})


@pytest.mark.parametrize("after", [
    "  Read   evidence.\n\nWrite a report.  ",
    "**Read** [evidence](https://example.invalid).\n\n_Write_ a report.",
    "**Read evidence.** **Write a report.**",
    "- Write a report.\n- Read evidence.",
    "Ｒｅａｄ evidence.\nWRITE A REPORT.",
    "Read\nevidence. Write a\nreport.",
])
def test_formatting_and_unit_reordering_are_unchanged(after):
    assert change("Read evidence. Write a report.", after) == 0


def test_directive_polarity_and_quantities_outweigh_synonyms():
    original = "Always inspect the source before writing a report."
    synonym = change(original, "Always inspect the source before writing a summary.")
    polarity = change(original, "Never inspect the source before writing a report.")
    ordering = change(original, "Always inspect the source after writing a report.")
    quantity = change("Read exactly 2 sources.", "Read exactly 3 sources.")
    assert polarity > synonym
    assert ordering > synonym
    assert quantity > synonym


def test_added_removed_rules_and_workflow_rewrites_score_high():
    original = "Read evidence. Write a report."
    extended = original + " Check each citation. Reject unsupported claims."
    assert change(original, extended) == 0.5
    assert change(extended, original) == 0.5
    assert change(original, "First identify unknowns. Compare independent accounts. Only then decide.") > 0.7
    assert change(original, "") == 1
    assert change("", original) == 1
    assert change("", " ") == 0


def test_unit_types_deduplication_and_fence_handling():
    before = "# Rules\n- Check sources.\n| Action | Deadline |\n| --- | --- |\n```python\nif ready:\n  act()\n```"
    after = "## **Rules**\n1. Check sources.\n| **Action** | Deadline |\n~~~text\nIF ready:\n act()\n~~~"
    assert change(before, after) == 0
    assert instruction_units(before) == ["check sources", "action deadline", "if ready act"]
    assert change("Check sources. Check sources.", "Check sources.") == 0
    assert instruction_units("```\nread()\n~~~\nwrite()\n````") == ["read write"]
    assert instruction_units("```\nread()") == ["read"]


def test_matching_is_stable_symmetric_and_resource_scoped():
    left = "Read sources. Inspect evidence. Write reports."
    right = "Write summaries. Read references. Inspect citations."
    expected = change(left, right)
    assert change(right, left) == pytest.approx(expected)
    assert change(left, "Inspect citations. Write summaries. Read references.") == expected
    assert behavior_change({"a": "Read sources."}, {"b": "Read sources."}) == 1
    assert behavior_change({}, {}) == 0


def test_hypothesis_similarity_uses_content_tokens():
    assert hypothesis_similarity("We will **prioritize evidence**.", "Prioritize the evidence!") == 1
    assert hypothesis_similarity("Prioritize evidence", "Reorder workflow") == 0
    assert hypothesis_similarity("Prioritize evidence workflow", "Prioritize evidence") == pytest.approx(2 / 3)
    assert hypothesis_similarity("", "the") == 1


@pytest.mark.parametrize('before,after', [
    ('- Always verify sources before publishing', '- **Always** verify sources\n  before publishing'),
    ('Publishing rules\n================\n\nVerify sources.', '# Publishing rules\n\nVerify sources.'),
    ('Publishing rules\n----------------\n\nVerify sources.', '## Publishing rules\n\nVerify sources.'),
    ('Always verify sources before publishing', '**Always** verify [sources](https://example.invalid)\nbefore publishing'),
])
def test_logical_markdown_units_ignore_wrapping_and_heading_style(before, after):
    assert change(before, after) == 0


def test_directives_stay_attached_to_condition_branches():
    before = 'If evidence is missing, never publish; otherwise proceed.'
    after = 'If evidence is missing, proceed; otherwise never publish.'
    assert change(before, after) > 0.08
    assert change(before + '\n\nCheck sources.', 'Check sources.\n\n' + before) == 0


@pytest.mark.parametrize('after', [
    'Verify sources; cite evidence.',
    'Verify sources, cite evidence!',
    '**Verify sources**； cite evidence.',
    'Verify sources.\n- Cite evidence.',
    'Cite evidence; verify sources.',
    '**Cite evidence**； verify sources.',
    'Cite evidence, verify sources!',
    '- Cite evidence.\n- Verify sources.',
])
def test_equivalent_punctuation_does_not_create_instruction_changes(after):
    before = 'Verify sources. Cite evidence.'
    assert change(before, after) == change(after, before) == 0


def test_punctuation_normalization_preserves_resource_and_directive_changes():
    assert behavior_change({'a': 'Verify sources. Cite evidence.'},
                           {'b': 'Verify sources; cite evidence.'}) == 1
    assert change('Verify sources. Never cite hearsay.',
                  'Verify sources; always cite hearsay.') > 0.08


def test_directives_stay_attached_to_actions_within_a_clause():
    before = 'Never publish unverified claims and always quote primary sources.'
    after = 'Always publish unverified claims and never quote primary sources.'
    assert change(before, after) == pytest.approx(change(after, before))
    assert change(before, after) > 0.08


def test_actions_stay_attached_to_distinct_conditions():
    before = 'If sources agree, publish; if sources disagree, abstain.'
    after = 'If sources agree, abstain; if sources disagree, publish.'
    assert change(before, after) > 0.08


@pytest.mark.parametrize('before,after', [
    ('Always verify sources before publishing. Cite evidence.',
     'Cite evidence; always verify sources before publishing.'),
    ('If sources agree, publish. If sources disagree, abstain.',
     'If sources disagree, abstain; if sources agree, publish.'),
    ('Before publishing, always verify sources. Cite evidence.',
     'Cite evidence; before publishing, always verify sources.'),
    ('If evidence is missing, never publish; otherwise proceed. Cite evidence.',
     'Cite evidence; if evidence is missing, never publish; otherwise proceed.'),
])
def test_punctuation_and_reordering_preserve_complete_conditional_rules(before, after):
    assert change(before, after) == change(after, before) == 0


@pytest.mark.parametrize('after', [
    'Verify sources. Cite evidence. Verify sources. Cite evidence.',
    'Verify sources. Cite evidence. Cite evidence.',
    '# Totally new heading\nVerify sources.\n## Another label\nCite evidence.',
    'Completely different label\n=========================\nVerify sources. Cite evidence.',
    '## Rewritten labels\n- Cite evidence.\n- Verify sources.\n- Cite evidence.',
])
def test_repetition_and_heading_labels_have_zero_change(after):
    before = '# Rules\nVerify sources. Cite evidence.'
    assert change(before, after) == change(after, before) == 0


def test_repetition_cannot_dilute_real_instruction_changes():
    before = 'Verify sources. Cite evidence.'
    after = 'Verify sources. Never cite hearsay.'
    assert change((before + ' ') * 10, (after + ' ') * 10) == change(before, after)
