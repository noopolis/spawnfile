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

- `selection.ts` shares exact-ID/unambiguous-short-name selection across context and authoring.
- `output.ts` chooses a durable default namespace outside every declared input; it ascends past project ancestors and keeps projects distinct.
- `execution.ts` lowers authored inputs, convention-based container declarations and explicit overrides; allocates canonical output parents separately; defines/maps the protected execution receipt. It never executes hooks or reads auth contents.
- Lowering distinguishes preparation declarations by version and image shape; lowered v1/v4 launch configs require an explicit immutable image.
- `execution.mutation.test.ts` deletes one key property at a time in an isolated source copy, restores it before the next runner, and requires that mutant's labelled assertion to fail; it never rewrites the working tree.
- Execution carries dataset byte pins captured with parsed moments; path mapping preserves hashes. Compatible images explicitly advertise the execution contract; mounting a receipt alone never establishes compatibility.
- `contract.ts` also owns shared execution version/capability constants so image authoring and launch share one wire identity without a preparation/execution import cycle; `execution.ts` preserves their public exports.

- `moments.ts` lowers every unique authored role/dataset/example through rewind, persists refusal reports and explicit Paideia datasets, and exposes fresh trial rewind with identity checks. Preparation hooks are declared names; org semantics stay in registered private integrations.
- Register each lowering entry before timestamp normalization; normalization failures are per-example refusals with null lineage, and later examples must still run.
- `compiledAgent.ts` validates the consumed compile-report projection and resolves exact agent IDs or names to host and container paths. Shared runtimes publish adapter-owned per-agent paths; missing associations refuse rather than infer layouts.
- Public exports include the fixed training-image faketime library path and the offline SQLite inspector with ordered room/sender filtering.

- `subjectLease.ts` is the public engine-neutral subject lease. Integrations name an engine, agent and slot; Spawnfile supplies every container path, projection input, credential ingress and the recycle. Grok resolves its projection through `broker/projection.ts`'s `resolveTrainingSlotProjection`, the same call the root entrypoint binds into the receipt, and must never re-derive a deny list or digest. Unknown engines refuse.
- `subjectDeclaration.ts` asserts declaration-level subject policy over the resolved project (Codex `codex_policy`, Grok `turn_limits` equal to the broker limits and a clocked slot).
