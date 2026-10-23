"""Mutation probes must turn the real admission regressions red."""
import inspect
import pytest

from . import boundaries, population, behavior_change
from .boundaries_test import test_boundary_admission_precedes_evaluation as check_boundary
from .instruction_text_test import test_metadata_only_proposal_never_reaches_evaluation as check_metadata, PADDING
from .population_test import TEXTS


@pytest.mark.parametrize('kind,after', [
    ('require-text', TEXTS[0]),
    ('forbid-text', TEXTS[0] + '\nInvent claims.'),
    ('preserve', TEXTS[0]),
])
def test_removing_each_boundary_check_is_killed(monkeypatch, kind, after):
    declaration = {'require-text': 'require-text ["guide", "Answer carefully."]',
                   'forbid-text': 'forbid-text ["guide", "Invent claims."]',
                   'preserve': 'preserve ["guide"]'}[kind]
    probe = lambda: check_boundary(declaration, after, False)
    probe()
    source = inspect.getsource(boundaries.boundary_violation)
    original = f"kind == '{kind}'"
    assert source.count(original) == 1
    namespace = {}
    exec(source.replace(original, 'False'), namespace)
    with monkeypatch.context() as patch:
        patch.setattr(population, 'boundary_violation', namespace['boundary_violation'])
        with pytest.raises(AssertionError):
            probe()
    probe()


def test_removing_metadata_filter_is_killed(monkeypatch):
    probe = lambda: check_metadata(PADDING[0], 0.08)
    probe()
    with monkeypatch.context() as patch:
        patch.setattr(behavior_change, 'instruction_text', lambda text: text)
        with pytest.raises(AssertionError):
            probe()
    probe()
