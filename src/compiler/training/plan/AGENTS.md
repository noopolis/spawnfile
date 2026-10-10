# Training Authoring Plan

- `contract.ts` defines the strict public `spawnfile.training-plan.v1` contract and JSON Schema.
- `types.ts` defines the loaded project, parsed data files, and filesystem facts.
- `load.ts` is the only I/O boundary: compile-graph resolution, YAML reads, and ownership facts.
- `resolve.ts` selects an exact agent and builds a deterministic plan without I/O or a clock.
- `references.ts` resolves override and record-volume identities from the existing compiled graph.
- `targets.ts` validates ownership, consumer sets, graders, and datasets without I/O.
- `index.ts` exports the public plan API; adjacent tests use temporary real projects.
- `fixtures.test-helper.ts` builds and cleans temporary test projects; it is excluded from package emission.

Keep runtime execution, source rewriting, recording, and Paideia delegation outside this folder.
Reuse existing manifest schemas and compiled access decisions; overrides cannot add resources.
Every target file belongs to its declaring manifest's tree, excluding nested Spawnfile trees.
Keep modules below 400 lines, use named exports, and keep filesystem calls in `load.ts`.
