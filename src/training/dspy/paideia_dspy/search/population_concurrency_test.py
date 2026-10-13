"""Bounded population callbacks use the real session and optimizer dispatch."""
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from ..optimizer import optimize
from ..protocol import BridgeError
from ..session import Session
from .population import ConcurrentEvaluator
from .population_test import Host, population_request


@pytest.mark.parametrize("concurrency", [1, 2, 4, 8])
def test_evaluator_overlaps_up_to_the_requested_bound(concurrency):
    cases = [f"v{index}" for index in range(concurrency * 2)]
    request = population_request(concurrency=concurrency, validationCaseIds=cases)
    ready, release, exceeded = threading.Event(), threading.Event(), threading.Event()
    lock = threading.Lock()
    active = peak = 0

    def host(method, params):
        nonlocal active, peak
        assert method == "evaluate"
        with lock:
            active += 1
            peak = max(peak, active)
            if active == concurrency:
                ready.set()
            if active > concurrency:
                exceeded.set()
        try:
            assert release.wait(5)
            return {"score": 0.5, "captureId": params["caseId"], "feedback": "", "output": ""}
        finally:
            with lock:
                active -= 1

    session = Session(request, host)
    with ThreadPoolExecutor(max_workers=1) as controller:
        running = controller.submit(ConcurrentEvaluator(session).evaluate_many, [
            {"caseId": case, "components": request.components} for case in cases
        ])
        try:
            assert ready.wait(5)
            assert not exceeded.wait(0.1)
        finally:
            release.set()
        results = running.result(timeout=5)
    assert peak == concurrency
    assert active == 0
    assert [result.captureId for result in results] == cases
    assert session.evaluations == len(cases)


def test_optimizer_dispatch_overlaps_train_and_validation_and_preserves_scores():
    request = population_request(concurrency=4,
        trainCaseIds=[f"t{index}" for index in range(4)],
        validationCaseIds=[f"v{index}" for index in range(4)],
        search={"variants": 1, "keep": 1, "rounds": 1},
        budget={"maxMetricCalls": 12, "maxProposals": 2})
    scripted = Host()
    barrier = threading.Barrier(4, timeout=5)
    # Each batch completes in reverse case order, without relying on sleeps.
    finished = [threading.Event() for _ in range(4)]
    completed = []

    def host(method, params):
        if method == "generate":
            return scripted(method, params)
        index = int(params["caseId"][1:])
        finished[index].clear()
        barrier.wait()
        if index < 3:
            assert finished[index + 1].wait(5)
        completed.append(params["caseId"])
        finished[index].set()
        training = params["split"] == "train"
        return {"score": index / 4, "captureId": params["caseId"],
                "feedback": '{"criteria":["quality"]}' if training else "",
                "output": "sample" if training else ""}

    result = optimize(request, host)["provenance"]
    assert completed == ["v3", "v2", "v1", "v0", "t3", "t2", "t1", "t0",
                         "v3", "v2", "v1", "v0"]
    assert result["optimizer"] == "paideia.population"
    assert result["evaluations"] == 12
    assert result["proposals"] == 2
    assert len(result["candidates"]) == 2
    assert all(candidate["perCaseScores"] == {f"v{i}": i / 4 for i in range(4)}
               for candidate in result["candidates"])
    assert all(candidate["validationScore"] == 0.375 for candidate in result["candidates"])


def test_concurrent_host_failure_cannot_become_a_successful_population_result():
    barrier = threading.Barrier(4, timeout=5)
    settled = []

    def host(method, params):
        assert method == "evaluate"
        barrier.wait()
        settled.append(params["caseId"])
        if params["caseId"] == "v0":
            raise BridgeError("quota_exhausted", "subscription quota exhausted")
        return {"score": 0.5, "captureId": params["caseId"], "feedback": "", "output": ""}

    with pytest.raises(BridgeError, match="quota exhausted") as error:
        optimize(population_request(concurrency=4, validationCaseIds=[f"v{i}" for i in range(4)]), host)
    assert error.value.code == "quota_exhausted"
    assert sorted(settled) == ["v0", "v1", "v2", "v3"]
