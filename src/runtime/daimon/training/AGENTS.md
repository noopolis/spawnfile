# Daimon training subjects

Daimon subjects train only as production-booted trials. `booted/` maps the
SubjectAdapter onto production-booted trial organizations (the trial launcher
lives in `src/compiler/training/trial/`). `index.ts` registers the Daimon subject
so the core accepts `--runtime daimon` for planning and dry-run; its factory
refuses, because only `spawnfile train` can supply a run's launcher.

Judges are booted too. `booted/judge.ts` is the one subscription inference
provider behind every Daimon engine id in the training and grader registries: it
wakes the run's warm, tool-free judge organization for its engine (launched by
`src/compiler/training/trial/launcher.ts`, bound for the run by
`src/cli/trainingBooted.ts`), validates the reply against the requested schema, and
refuses a wake whose transcript shows tool activity. Outside `spawnfile train` it
refuses. No host engine CLI and no personal login is ever used.
