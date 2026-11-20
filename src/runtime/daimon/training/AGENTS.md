# Daimon training subjects

Daimon subjects train only as production-booted trials. `booted/` maps the
SubjectAdapter onto production-booted trial organizations (the trial launcher
lives in `trial/`). `index.ts` registers the Daimon subject
so the core accepts `--runtime daimon` for planning and dry-run; its factory
refuses, because only `spawnfile train` can supply a run's launcher.

Judges are booted too. `booted/judge.ts` is the one subscription inference
provider behind every Daimon engine id in the training and grader registries: it
wakes the run's warm, tool-free judge organization for its engine (launched by
`trial/launcher.ts`, bound for the run by
`src/cli/trainingBooted.ts`), validates the reply against the requested schema, and
refuses a wake whose transcript shows tool activity. Outside `spawnfile train` it
refuses. No host engine CLI and no personal login is ever used.


`inferenceProviders.ts` and `graderProviders.ts` declare native providers and
the existing council policy. The adapter registers them through
`../trainingCapability.ts` and loads them when training composition asks.
The trial hosts implement live runs, judge sessions and volume-held login.
