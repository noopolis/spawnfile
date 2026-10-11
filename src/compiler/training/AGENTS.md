# Canonical Training Context

- `container/` owns the single-container actual-training launch; no model process runs on the host.
- `contract.ts` owns the strict, versioned public JSON handoff to Paideia.
- `context.ts` resolves the full compiler graph and pins source files without compiling or launching it.
- `resolution.ts` merges direct-member training metadata during traversal and preserves declaring sources.
- `plan/` owns local authoring-file loading, pure plan resolution, and the public training-plan schema.
- `rewind/` materializes authored moments from contained local history, with explicit fidelity and an independent disk leak check; it never runs trials.
- Preserve resolved inheritance and exact agent IDs. Never create a second agent declaration.
- Source mappings are project-relative editable files, not runtime-native destinations or flattened prompts.
- Do not serialize secret values, arbitrary environments or transport credentials.
- Spawnfile owns the training authoring schemas and static plan; Paideia owns evaluation and optimization execution. Its native integration must consume Spawnfile compilation.
- Dry-run extraction performs local reads only; no Docker, auth, deployment or model calls.
- Keep files below 400 lines and tests adjacent. Test real graph resolution and negative source/selection cases.
