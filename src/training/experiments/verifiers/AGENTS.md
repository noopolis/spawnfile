# Verifier controls of a training run

Owns the run-level guards that keep a prompt from learning its grader. The training owner (`../training`)
calls these; the canonical account is docs/training/questionnaire.md.

- `levels.ts`: a check's declared `feedback` level (`full`, `status`, `none`) as the optimizer projection
  reads it: which checks keep parameters and reasons, which keep id, status and score, which are absent.
- `repeats.ts`: `validation_repeats`. A validation callback runs its case once per repeat, in turn, and the
  search receives the mean. Further trials use `validationRepeatKey`, so a resumed run restores each one.
- `selection.ts`: selection after a finished search. The declared gap rule measures every candidate's open
  and hidden questionnaire scores and gate failure rate over validation trials and removes a candidate past
  a threshold; the critic then reviews what remains. Critic reviews are kept in `critic.json` beside the
  training checkpoint, bound to everything a review depends on, so a resumed run never pays twice. An
  errored review is never kept.

Rules:

- The baseline is never rejected and always remains selectable.
- A candidate the rule cannot measure is not rejected by it.
- Hidden questions reach selection only as scores; nothing here writes optimizer text.
- Tests live beside source; keep every file above the 90% coverage floor and under 400 lines.

`ladder.ts` owns opt-in `scoring.search: ladder`: a failed trial's search score is its stage score times
every failed gate's factor (a laddered questionnaire's own, `gate_penalty` otherwise), with the
`missing_output` floor for a trial that filed nothing. Acceptance (status `pass`) stays strict, is
reported beside the search mean, and selection rejects a candidate accepting less often than the
baseline. `ladderFeedback`: the ladder rung enters train feedback through open questionnaire projections only.
