"""Pinned DSPy GEPA invocation; no alternative optimization algorithm."""

from importlib.metadata import version

import dspy

from .checkpoint import Checkpoint
from .native import NativeProgram, metric
from .protocol import BridgeError, OptimizeRequest
from .reflection import ComponentProposer, SubscriptionLM
from .session import Session

DSPY_VERSION = "3.3.1"
GEPA_VERSION = "0.1.4"


def optimize(request: OptimizeRequest, host):
    if version("dspy") != DSPY_VERSION or version("gepa") != GEPA_VERSION:
        raise BridgeError("version_mismatch", "install the pinned DSPy and GEPA releases")
    if request.search is not None:
        from .search.population import optimize_population
        return optimize_population(request, host)
    session = Session(request, host)
    checkpoint = Checkpoint(session) if request.checkpoint else None
    student = NativeProgram(session)
    reflection_lm = SubscriptionLM(session)
    optimizer = dspy.GEPA(
        metric=metric,
        max_metric_calls=max(1, request.budget.maxMetricCalls - session.extra_evaluations),
        reflection_minibatch_size=None if checkpoint else 1,
        reflection_lm=reflection_lm,
        instruction_proposer=ComponentProposer(session),
        component_selector="all",
        candidate_selection_strategy="current_best",
        use_merge=False,
        num_threads=request.concurrency,
        track_stats=True,
        log_dir=str(checkpoint.work) if checkpoint else None,
        seed=request.seed,
        gepa_kwargs={"stop_callbacks": [session.should_stop],
                     **(checkpoint.kwargs() if checkpoint else {}),
                     "callbacks": [session, *([checkpoint] if checkpoint else [])]},
    )
    # The only generation route is reflection_lm. Native Predict overrides its
    # adapter and LM in forward; no global DSPy model or teacher is consulted.
    with dspy.context(lm=reflection_lm, track_usage=False, callbacks=[]):
        selected = optimizer.compile(
            student,
            trainset=[dspy.Example(case_id=case_id).with_inputs("case_id")
                      for case_id in request.trainCaseIds],
            valset=[dspy.Example(case_id=case_id).with_inputs("case_id")
                    for case_id in request.validationCaseIds],
        )
    session.healthy()
    if checkpoint:
        # GEPA writes its final state without dispatching on_state_saved. Pair
        # that state with final benign-stop/history bookkeeping before returning.
        checkpoint.on_state_saved(None)
    stats = selected.detailed_results
    return {
        "components": selected.components(),
        "provenance": {
            "optimizer": "dspy.GEPA", "dspyVersion": DSPY_VERSION, "gepaVersion": GEPA_VERSION,
            "seed": request.seed, "evaluations": session.evaluations, "proposals": session.proposals,
            "selectedCandidateIndex": stats.best_idx,
            "candidates": [
                {"components": candidate.components(), "parents": stats.parents[index],
                 "validationScore": stats.val_aggregate_scores[index],
                 "discoveryEvaluations": stats.discovery_eval_counts[index]}
                for index, candidate in enumerate(stats.candidates)
            ],
            "captures": session.captures, "generations": session.generations,
        },
    }
