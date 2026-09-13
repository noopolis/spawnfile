# Canonical Training Context

- `contract.ts` owns the strict, versioned public JSON handoff to Paideia.
- `context.ts` resolves the full compiler graph and pins source files without compiling or launching it.
- Preserve resolved inheritance and exact agent IDs. Never create a second agent declaration.
- Source mappings are project-relative editable files, not runtime-native destinations or flattened prompts.
- Do not serialize secret values, arbitrary environments or transport credentials.
- Paideia owns datasets, evaluation, budgets and optimization. Its native integration must consume Spawnfile compilation.
- Dry-run extraction performs local reads only; no Docker, auth, deployment or model calls.
- Keep files below 400 lines and tests adjacent. Test real graph resolution and negative source/selection cases.
