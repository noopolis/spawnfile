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
- `execution.ts` lowers authored inputs, convention-based container declarations and explicit overrides; allocates canonical output parents separately; defines/maps the protected execution receipt. It never executes hooks or reads auth contents.
- Lowering distinguishes preparation declarations by version and image shape; lowered v1/v4 launch configs require an explicit immutable image.
- `execution.mutation.test.ts` deletes one key property at a time in an isolated source copy, restores it before the next runner, and requires that mutant's labelled assertion to fail; it never rewrites the working tree.
- Execution carries dataset byte pins captured with parsed moments; path mapping preserves hashes. Compatible images explicitly advertise the execution contract; mounting a receipt alone never establishes compatibility.
- `contract.ts` also owns shared execution version/capability constants so image authoring and launch share one wire identity without a preparation/execution import cycle; `execution.ts` preserves their public exports.
