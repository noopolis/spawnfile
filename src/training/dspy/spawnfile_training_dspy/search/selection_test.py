import pytest

from .selection import select


def candidate(a, b):
    return {"validationScore": (a + b) / 2, "perCaseScores": {"a": a, "b": b}}


def test_pareto_prefers_specialist_over_dominated_higher_mean():
    candidates = [candidate(.9, .9), candidate(.8, .8), candidate(1, .1)]
    assert select(candidates, [0, 1, 2], 2, "pareto") == [0, 2]
    assert select(candidates, [0, 1, 2], 2, "top-k") == [0, 1]


@pytest.mark.parametrize("mode", ["pareto", "top-k"])
def test_keep_is_bounded_seed_can_drop_and_ties_use_stable_id(mode):
    candidates = [candidate(0, 0), candidate(1, 0), candidate(0, 1), candidate(.6, .6)]
    assert select(candidates, [2, 0, 3, 1], 2, mode) == [3, 1]
    assert select(candidates, [2, 1, 1], 3, mode) == [1, 2]
    assert select(candidates, [], 2, mode) == []


def test_pareto_fills_short_front_by_mean():
    candidates = [candidate(1, 1), candidate(.8, .8), candidate(.7, .7)]
    assert select(candidates, [2, 1, 0], 2, "pareto") == [0, 1]
    assert select([candidate(.5, .5)], [0], 2, "pareto") == [0]


def test_invalid_selection_fails_closed():
    with pytest.raises(ValueError, match="keep"):
        select([], [], 0, "pareto")
    with pytest.raises(ValueError, match="selection"):
        select([], [], 1, "random")
    with pytest.raises(ValueError, match="complete matching"):
        select([{"validationScore": 0, "perCaseScores": {}}], [0], 1, "pareto")
    with pytest.raises(ValueError, match="complete matching"):
        select([candidate(1, 1), {"validationScore": 0, "perCaseScores": {"a": 0}}], [0, 1], 1, "pareto")
