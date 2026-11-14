# Production-booted Daimon subject

One training trial is the subject's real compiled organization, booted the
production way (`src/compiler/training/trial/`). This adapter maps the
engine-neutral `SubjectAdapter` contract onto an injected launcher: `start`
boots one trial organization with the candidate's instructions, every `run`
posts one wake and waits on its receipt, `stop` tears the organization down.

- `adapter.ts` owns the mapping only: receipt state to turn status, the usage
  ledger rows a wake appended to `Usage`, and the receipt and transcript as
  adapter-owned evidence. It never compiles, runs Docker or names an engine;
  composition (`src/cli/trainingExecution.ts`) injects the launcher.
- A failed turn, or a delivery Daimon deferred after its failed retry, whose relayed
  failure text reads as a subscription quota or rate limit (`quotaFailure`,
  engine-neutral wording) is `failed` with `failure: 'quota'` and the quota sentence
  in its error. Any other delivery Daimon deferred with a failure is a `failed` turn:
  only a deferral with no failure is the subject's own choice.
- A failed turn whose failure reads as the wall-clock bound (`timeoutFailure`:
  `limit=timeout`, "timed out", "wall-clock bound") after measured model output
  (a usage row with output tokens) is the subject missing its deadline: `failed`
  with `limit: 'timeout'`, scored as a declared-limit stop (absent filing fails
  its checks, usage counted). With no measured model output it is a hang and stays
  an unlabelled failure for the infrastructure policy.
- Every turn that did not complete hands the runtime's whole failure text to the
  core as `failureText` (kept in the trial's evidence directory) and names it in
  one bounded line of `error`, so no failure reads as a bare state. A wake still
  open at the trial's deadline carries the failed execution behind its retry as
  explanation only: it is never classified as quota or a declared limit. `start`
  passes the core's `evidencePath` to the launcher, and `stop` names the failure
  the runtime still reported at teardown in the stop receipt's detail.
- Prompt tokens are `total - output` of each row, so cached reads count inside
  input whether the engine reports them inside `input` or beside it.
- Absent usage rows are `usage: null`, never zero. A receipt that never
  reached a terminal state before the trial deadline is a `failed` turn.
- The transcript is operator-only: a `diagnostic` observation, never output.
- `judge.ts` is the booted judge: `createBootedJudgeInference` maps one
  `InferenceRequest` onto one wake of the run's judge for its engine, model and
  effort (`BootedJudgeLauncher`, bound per run with `bindBootedJudges`). System,
  prompt and schema become the wake text; the reply is validated after the wake;
  `transcriptToolActivity` refuses any record or item kind that is tool activity
  (engine-neutral: kinds only), and a missing transcript is refused too.
