# Canonical Training Context

- `trial/` owns actual training: production-booted trials for Daimon subjects, one compiled organization container per trial, sharing one auth gateway sidecar per run. There is no other training launch.
- `contract.ts` owns the strict, versioned public JSON handoff to the training core.
- `context.ts` resolves the full compiler graph and pins source files without compiling or launching it.
- `resolution.ts` merges direct-member training metadata during traversal and preserves declaring sources.
- `plan/` owns local authoring-file loading, pure plan resolution, and the public training-plan schema.
- `rewind/` materializes authored moments from contained local history, with explicit fidelity and an independent disk leak check; it never runs trials.
- Preserve resolved inheritance and exact agent IDs. Never create a second agent declaration.
- Source mappings are project-relative editable files, not runtime-native destinations or flattened prompts.
- Do not serialize secret values, arbitrary environments or transport credentials.
- Spawnfile owns the training authoring schemas and static plan; Spawnfile training owns evaluation and optimization execution. Its native integration must consume Spawnfile compilation.
- Dry-run extraction performs local reads only; no Docker, auth, deployment or model calls.
- Keep files below 400 lines and tests adjacent. Test real graph resolution and negative source/selection cases.

- `selection.ts` shares exact-ID/unambiguous-short-name selection across context and authoring.
- `output.ts` chooses a durable default namespace outside every declared input; it ascends past project ancestors and keeps projects distinct.
- `execution.ts` lowers authored inputs and explicit overrides into training CLI arguments; allocates canonical output parents separately; defines the execution receipt. It never executes hooks or reads auth contents.
- `execution.mutation.test.ts` deletes one key property at a time in an isolated source copy, restores it before the next runner, and requires that mutant's labelled assertion to fail; it never rewrites the working tree.
- Execution carries dataset byte pins captured with parsed moments.

- `moments.ts` lowers every unique authored role/dataset/example through rewind, persists refusal reports and explicit training datasets, and exposes fresh trial rewind with identity checks. Preparation hooks are declared names; org semantics stay in registered private integrations.
- Register each lowering entry before timestamp normalization; normalization failures are per-example refusals with null lineage, and later examples must still run.
- `compiledAgent.ts` validates the consumed compile-report projection and resolves exact agent IDs or names to host and container paths. Shared runtimes publish adapter-owned per-agent paths; missing associations refuse rather than infer layouts.
- Public exports include the offline SQLite inspector with ordered room/sender filtering.
