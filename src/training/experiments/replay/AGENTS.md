# Explicit captured-run rescoring

Owns new terminal-stage evaluations over an authenticated immutable stored trial.
Public seam: index.ts. Consume storage, evaluation and training criteria through
public indexes; never import or invoke a subject adapter.

- Plain playback performs no inference. Only an explicit rescore may call a judge.
- Preserve original execution, coverage, stop evidence and decisive mechanical
  failure; changed criteria never create another native trial.
- Require evaluator/operator authorization, intact stored evidence and exactly one
  original trial report. Reject per-turn checks without saved turn snapshots.
- Freeze new criteria and evaluate a clone of the original final snapshot.
- Append a separate immutable evaluator-only rescore record; never replace history.
- Test real-store access, integrity, truncation, immutable append and stopped runs.

Explicit rescoring appends returned raw judge attempts as evaluator-only events
linked to its evaluation ID. Preserve the trusted observer while freezing routes;
raw attempts are not native observations or optimizer feedback.

`capturedTrial` is the shared public read/verify seam for an authenticated original
report, its manifest, snapshot observations and artifact hashes. Preserve current
judge failure/fallback/cache provenance and authored stage weights through schema
validation; dropping those fields changes recovery policy and cost evidence.

Evaluation services preserve injected grader runtimes alongside judges and embeddings.
Replay preserves the complete typed grader result, calibration/scoring identity,
coverage and measured judge billing/timing on every nested result surface. Validate
those fields explicitly; object stripping must never erase grading evidence.
Judge-call replay retains typed refused outcomes and tool-call failure details.

Replay explicitly validates atomicGrading identities, probabilities, decomposition,
extraction/audit diagnostics and invocation-owned API receipts; never strip them.
