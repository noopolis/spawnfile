# Daimon training subjects

Daimon subjects train only as production-booted trials. `booted/` maps the
SubjectAdapter onto production-booted trial organizations (the trial launcher
lives in `src/compiler/training/trial/`). `index.ts` registers the Daimon subject
so the core accepts `--runtime daimon` for planning and dry-run; its factory
refuses, because only `spawnfile train` can supply a run's launcher.

`providers/` owns the parent-process inference routes graders and evaluators use:
`codex-subscription/` and `grok-subscription/`, over the operator's saved logins.
They belong here because this runtime owns the engines. No host dependency on
the Daimon package is permitted.
