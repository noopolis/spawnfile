# Training Authoring Plan

- `contract.ts` defines the strict public `spawnfile.training-plan.v1` contract and JSON Schema.
- `types.ts` defines the loaded project, parsed datasets, grader file references, and filesystem facts.
- `load.ts` is the only training-file I/O boundary: target preflight before compiler source reads, compile-graph resolution, dataset YAML reads, and ownership facts. Dataset and grader paths must be regular files lexically and physically inside the project root; grader contents are never read.
- `load.targetSources.test.ts` preserves consumed-target diagnostics and compile/plan validation boundaries.
- `load.compileOutput.test.ts` compares every emitted compile file and report byte with and without non-recording training declarations; recording reports are tested in the compiler.
- `resolve.ts` selects a canonical agent by exact ID or unambiguous short name and builds a deterministic plan without I/O or a clock.
- Plans declare a 12-hour experiment default and preserve independently authored trial deadlines.
- `references.ts` resolves override and record-volume identities from the existing compiled graph;
  its pure record-volume selector also serves Daimon recording lowering (without importing I/O).
- `targets.ts` validates ownership, consumer sets, graders, and datasets without I/O.
- `index.ts` exports the public plan API; adjacent tests use temporary real projects.
- `fixtures.test-helper.ts` builds and cleans temporary test projects; it is excluded from package emission.

Keep runtime execution, source rewriting, recording, and training-core orchestration outside this folder.
Reuse existing manifest schemas and compiled access decisions; overrides cannot add resources.
Every target file belongs to its declaring manifest's tree, excluding nested Spawnfile trees.
Keep modules below 400 lines, use named exports, and keep filesystem calls in `load.ts`.

- Selection delegates to ../selection.ts; exact IDs take precedence over unambiguous authored names. Execution lowering remains outside this folder.
- Dataset loading hashes the same buffer it parses; execution consumes these internal pins without changing the public authoring-plan schema.

- Optional preparation hook names inherit through direct membership; declaration-relative history paths resolve once and remain optional in the public plan.
