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
