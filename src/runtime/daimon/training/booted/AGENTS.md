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
- Absent usage rows are `usage: null`, never zero. A receipt that never
  reached a terminal state before the trial deadline is a `failed` turn.
- The transcript is operator-only: a `diagnostic` observation, never output.
- `judge.ts` is the booted judge: `createBootedJudgeInference` maps one
  `InferenceRequest` onto one wake of the run's judge for its engine, model and
  effort (`BootedJudgeLauncher`, bound per run with `bindBootedJudges`). System,
  prompt and schema become the wake text; the reply is validated after the wake;
  `transcriptToolActivity` refuses any record or item kind that is tool activity
  (engine-neutral: kinds only), and a missing transcript is refused too.
