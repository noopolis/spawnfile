# Canonical Training Context

- `container/` owns the single-container actual-training launch; no model process runs on the host.
- `session/` receives execution receipts end to end and supplies public canonical candidate compilation and fresh leased-slot reset/preflight operations for the built-in Paideia integration; it never schedules model work or implements domain hooks.
- `contract.ts` owns the strict, versioned public JSON handoff to Paideia.
- `context.ts` resolves the full compiler graph and pins source files without compiling or launching it.
- Resource definition digests retain the declaring scope relative to the project,
  never its host mount address. Generated training pins use the same identity root.
  `context.relocation.test.ts` verifies mapped receipt activation against copied historical resources.
- `resolution.ts` merges direct-member training metadata during traversal and preserves declaring sources.
- `plan/` owns local authoring-file loading, pure plan resolution, and the public training-plan schema.
- `rewind/` materializes authored moments from contained local history, with explicit fidelity and an independent disk leak check; it never runs trials.
- Preserve resolved inheritance and exact agent IDs. Never create a second agent declaration.
- Source mappings are project-relative editable files, not runtime-native destinations or flattened prompts.
- Do not serialize secret values, arbitrary environments or transport credentials.
- Spawnfile owns the training authoring schemas and static plan; Paideia owns evaluation and optimization execution. Its native integration must consume Spawnfile compilation.
- Dry-run extraction performs local reads only; no Docker, auth, deployment or model calls.
- Keep files below 400 lines and tests adjacent. Test real graph resolution and negative source/selection cases.

- `selection.ts` shares exact-ID/unambiguous-short-name selection across context and authoring.
- `output.ts` chooses a durable default namespace outside every declared input; it ascends past project ancestors and keeps projects distinct.
- `execution.ts` lowers authored inputs, convention-based container declarations and explicit overrides; allocates canonical output parents separately; defines/maps the protected execution receipt. It never executes hooks or reads auth contents.
- A v4 execution receipt also carries `session: {version: spawnfile.training-session.v1, slots}`. Path mapping and resume identity retain it; v2 remains a legacy non-broker launch.
- Lowering distinguishes preparation declarations by version and image shape; lowered v1/v4 launch configs require an explicit immutable image.
- `execution.mutation.test.ts` deletes one key property at a time in an isolated source copy, restores it before the next runner, and requires that mutant's labelled assertion to fail; it never rewrites the working tree.
- Execution carries dataset byte pins captured with parsed moments; path mapping preserves hashes. Compatible images explicitly advertise the execution contract; mounting a receipt alone never establishes compatibility.
- `contract.ts` also owns shared execution version/capability constants so image authoring and launch share one wire identity without a preparation/execution import cycle; `execution.ts` preserves their public exports.

- `moments.ts` lowers every unique authored role/dataset/example through rewind, persists refusal reports and explicit Paideia datasets, and exposes fresh trial rewind with identity checks. Preparation hooks are declared names; org semantics stay in registered private integrations.
- Register each lowering entry before timestamp normalization; normalization failures are per-example refusals with null lineage, and later examples must still run.

- Execution lowering carries the one declared input enclosing the canonical
  project as `sourceRoot`. Mapping relocates it with the input mount; activation
  binds it for nested repository compilation and immutable resume identity.
