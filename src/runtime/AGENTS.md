# Runtime Guide

This folder owns runtime adapters and runtime option validation.

## Structure

```text
src/runtime/
├── index.ts               # Barrel for adapter registry exports
├── scaffoldAssets.ts      # Shared loader for runtime-owned init template assets
├── types.ts               # Shared adapter contract types
├── common.ts              # Shared lowering helpers used by adapters
├── mnemeMcp.ts            # Shared Mneme MCP lowering used by MCP-capable runtimes
├── container.ts           # Container install recipes (createRuntimeInstallRecipe) per bundled runtime
├── containerPackageOverrides.ts # Runtime install npm package override contract consumed by container.ts
├── registry.ts            # Bundled adapter registration and lookup
├── scheduleUtils.ts       # Shared duration schedule helpers for runtime lowering
├── openclaw/              # OpenClaw adapter implementation
├── picoclaw/              # PicoClaw adapter implementation
├── common.test.ts         # Shared runtime helper tests
└── registry.test.ts       # Adapter registry tests
```

Adapter-specific behavior belongs in the runtime subfolders. That includes runtime-owned init scaffolds and scaffold markdown assets. `common.ts` should only hold logic that is truly shared across adapters.

`common.ts` also owns the `NOOPOLIS_RUN_ID` container env constant (`NOOPOLIS_RUN_ID_ENV` / `resolveNoopolisRunId`); `container.ts` reads it via `createRuntimeContainerEnv` and stamps it into every generated `RuntimeInstallRecipe.env` so every authority container agrees on one run id for causal event envelopes (see `specs/CAUSAL.md`). Never read `run_id` or `principal_id` from model output here.

`common.ts` additionally exports `ensureNoopolisRunId(env = process.env)`: the one place a run id is ever generated. It returns the host-provided value untouched when `resolveNoopolisRunId` already finds one, otherwise it generates a fresh id (`run-<hex uuid>`) and stamps it onto `env` before returning it. It is exported through this folder's barrel (`index.ts`) so `src/compiler/runProject.ts` and `src/compiler/upProject.ts` can call it once, at the top of their `run`/`up` execution functions, before invoking `compileProject`/`buildProject` — never from inside `compileProject.ts`/`buildProject.ts` themselves, which must stay deterministic functions of whatever is already in the host env. `src/e2e/officeSim.ts` calls it too, since that harness builds a container directly rather than going through `runProject`/`upProject`. Without this, a host that never sets `NOOPOLIS_RUN_ID` (a bare `spawnfile up`, or an E2E harness) leaves `createRuntimeContainerEnv` with nothing to stamp, and moltnet's `causal.jsonl` capture ends up empty even though mneme/daimon still emit under their own `"unset-run"` fallback.

`containerPackageOverrides.ts` defines the `RuntimeContainerPackageOverrides` contract (`packageName -> { filename }`) that `createRuntimeInstallRecipe` (`container.ts`) accepts as an optional `packageOverrides` argument. When a runtime install npm package (currently only `@noopolis/daimon` / `@noopolis/mneme`, in the `daimon` and `pi` recipe cases) has an override entry, its install spec is rewritten from the pinned `name@version` registry form to the vendored tarball path under `/opt/spawnfile/vendor`, and a single `COPY container/vendor/ /opt/spawnfile/vendor/` line is added to that recipe's `copyCommands`. With no overrides (the default for every standard compile), every install spec and the Dockerfile it renders into stay byte-identical to before this module existed. The actual `npm pack`-into-build-context step is compiler-level I/O and lives in `src/compiler/containerPackageOverrides.ts`; this folder only owns the recipe-shaping contract, never the packing.

`types.ts`'s `ContainerTarget` carries an optional `engineByNodeId?: Record<string, string>` (Piece 5, Slice B): a generic passthrough slot for an adapter that has an "engine kind" concept per compiled node to disclose it on the compile report. Only `src/runtime/pi/adapter.ts`'s `createContainerTargets` currently populates it (node id -> resolved `PI_ENGINE_KINDS` value, e.g. `"scripted"`); `src/compiler/containerArtifactsPlans.ts`/`containerArtifacts.ts` thread it, unchanged, into `ContainerRuntimeInstanceReport.engine_by_node_id` (`src/report/types.ts`). Other adapters simply omit it.

`MNEME_RECALL_MODE` (mneme's own `MNEME_RECALL_MODE_ENV`, see `ecosystem/mneme/src/runtime/recallMode.ts`) is the B70 memory recall-mode ablation knob (`on`/`off`/`shuffled`). It follows the same trust shape as `NOOPOLIS_RUN_ID` and `MNEME_OLLAMA_BASE_URL`: a harness/container-injected environment variable, read directly inside mneme's `JsonlMemoryRuntime` constructor, never a config field this package lowers, never a model-facing tool argument, and never model-writable. That is intentional — Daimon and the Pi prelude (`appPreludeSource.ts`'s `createMemoryRuntimeOptions`) pass no `recallMode` field, so a generated container that never sets the env var always resolves to `on`, and this folder needed zero changes to add the ablation knob. Only an operator's own process env, or `src/runtime/pi/appCliSource.test.ts`'s "wired to the real @noopolis/mneme memory runtime" case (which sets it directly, in-process, per mode) may set it.

`RuntimeAuthPreparationInput.authProfile` (`types.ts`) is `ResolvedAuthProfile | null`, not required. `src/compiler/runProjectAuth.ts`'s `prepareRuntimeAuthMounts` calls every adapter's `prepareRuntimeAuth` unconditionally — it no longer short-circuits to empty mounts just because `spawnfile run`/`up` was invoked without `--auth-profile`. This matters because not every adapter mount depends on the Spawnfile-managed auth profile: the Pi adapter's optional grok/codex/antigravity CLI-home staging (`src/runtime/pi/runAuth.ts`'s `collectOptionalCliHomeMounts`) reads straight from the host's `~/.grok`/`~/.codex`/antigravity directories (or their `*_HOME` env overrides) regardless of any profile, mirroring `src/e2e/officeSim.ts`'s `stageGrokHome` test harness. Before this, a composed real-engine deployment invoked with no `--auth-profile` (e.g. `simfile`'s driver, which is charter-forbidden from handling auth at all) skipped this staging entirely, so a `pi` instance declaring `engine: grok` got a full grok-home tree with no `auth.json` and every grok turn failed at auth. Each adapter's `prepareRuntimeAuth` must treat a `null` `authProfile` as "no profile-derived imports available," never throw — `preparePiRuntimeAuth`, `prepareOpenClawRuntimeAuth`, and `preparePicoClawRuntimeAuth` all null-safe their `input.authProfile?.imports[...]` lookups for exactly this reason.

## Rules

- Adapters receive resolved nodes, not raw manifests.
- Keep runtime-specific behavior isolated here.
- Share only the adapter contract, not runtime-specific implementation details.
