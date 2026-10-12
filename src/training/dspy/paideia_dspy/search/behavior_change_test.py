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


def test_unit_types_duplicate_counts_and_fence_handling():
    before = "# Rules\n- Check sources.\n| Action | Deadline |\n| --- | --- |\n```python\nif ready:\n  act()\n```"
    after = "## **Rules**\n1. Check sources.\n| **Action** | Deadline |\n~~~text\nIF ready:\n act()\n~~~"
    assert change(before, after) == 0
    assert instruction_units(before) == ["rules", "check sources", "action deadline", "if ready act"]
    assert change("Check sources. Check sources.", "Check sources.") == 0.5
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
