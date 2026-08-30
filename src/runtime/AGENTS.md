# Runtime Guide

This folder owns runtime adapters and runtime option validation.

## Structure

```text
src/runtime/
├── index.ts               # Barrel for adapter registry exports
├── scaffoldAssets.ts      # Shared loader for runtime-owned init template assets
├── types.ts               # Shared adapter contract types
├── common.ts              # Shared lowering helpers used by adapters
├── mnemeMcp.ts            # Shared Mneme MCP lowering plus the durable memory mount authority
├── container.ts           # Container install recipes (createRuntimeInstallRecipe) per bundled runtime
├── containerPackageOverrides.ts # Runtime install npm package override contract consumed by container.ts
├── localDaimonAuthority.ts # Exact non-production identity-file parser for loopback Daimon images
├── registry.ts            # Bundled adapter registration and lookup
├── usageLedger.ts         # Pure parser/aggregator for Daimon's per-turn usage ledger
├── usageLedgerRead.ts     # Ledger read transport: `cat`s both generations through a caller-supplied exec and separates "absent" from "unreadable"
├── scheduleUtils.ts       # Shared duration schedule helpers for runtime lowering
├── daimon/                # Public Daimon organization-host adapter
├── openclaw/              # OpenClaw adapter implementation
├── picoclaw/              # PicoClaw adapter implementation
├── common.test.ts         # Shared runtime helper tests
└── registry.test.ts       # Adapter registry tests
```

Adapter-specific behavior belongs in the runtime subfolders. That includes runtime-owned init scaffolds and scaffold markdown assets. `common.ts` should only hold logic that is truly shared across adapters.

`mnemeMcp.ts` also owns `resolveMnemeDurableMemoryMountPath`, the single
authority for "does this memory bank get a durable container volume, and at what
path". `src/compiler/memoryArtifacts.ts` calls it to emit the persistent mount
(which is also what puts the path into the Daimon UID entrypoint's writable state
roots, i.e. what chowns a fresh volume to the runtime uid), and `daimon/config.ts`
calls it to decide whether to emit an agent `memory` block at all. Keep those two
sides on this one function: a config that points an in-process Mneme runtime at a
path the container does not mount fails at its first write instead of degrading.

`common.ts` owns where declared `workspace.skills` are emitted. `createSkillFiles` accepts either one root or a list of roots, and the roots are named constants there: `WORKSPACE_SKILL_BASE_DIRECTORY` (`workspace/skills`) for OpenClaw and PicoClaw, which read that directory with their own skill loaders, and `CLI_ENGINE_SKILL_BASE_DIRECTORIES` (`workspace/.agents/skills` and `workspace/.codex/skills`) for Daimon and Pi, whose skills are discovered by an external coding-agent CLI. Both CLI-engine roots are required and their files are byte-identical on purpose: `.codex/skills` is Codex's own discovery root and `.agents/skills` is the generic root grok, agy, and other file-reading engines use. This mirrors the Moltnet skill install exactly — `resolveMoltnetWorkspaceLayout` in `src/compiler/moltnetClientConfig.ts` runs `moltnet skill install --runtime codex` for these runtimes and Moltnet writes both roots — and it is the reason declared skills now reach an engine at all: a plain `workspace/skills/` root is read by no engine Daimon or Pi can host, so everything emitted there was invisible.

`common.ts` also owns the `NOOPOLIS_RUN_ID` container env constant (`NOOPOLIS_RUN_ID_ENV` / `resolveNoopolisRunId`); `container.ts` reads it via `createRuntimeContainerEnv` and stamps it into every generated `RuntimeInstallRecipe.env` so every authority container agrees on one run id for causal event envelopes (see `specs/CAUSAL.md`). Never read `run_id` or `principal_id` from model output here.

`common.ts` additionally exports `ensureNoopolisRunId(env = process.env)`: the one place a run id is ever generated. It returns the host-provided value untouched when `resolveNoopolisRunId` already finds one, otherwise it generates a fresh id (`run-<hex uuid>`) and stamps it onto `env` before returning it. It is exported through this folder's barrel (`index.ts`) so `src/compiler/runProject.ts` and `src/compiler/upProject.ts` can call it once, at the top of their `run`/`up` execution functions, before invoking `compileProject`/`buildProject` — never from inside `compileProject.ts`/`buildProject.ts` themselves, which must stay deterministic functions of whatever is already in the host env. `src/e2e/officeSim.ts` calls it too, since that harness builds a container directly rather than going through `runProject`/`upProject`. Without this, a host that never sets `NOOPOLIS_RUN_ID` (a bare `spawnfile up`, or an E2E harness) leaves `createRuntimeContainerEnv` with nothing to stamp, and moltnet's `causal.jsonl` capture ends up empty even though mneme/daimon still emit under their own `"unset-run"` fallback.

`containerPackageOverrides.ts` defines the `RuntimeContainerPackageOverrides` contract (`packageName -> { filename }`) used by the legacy Pi recipe. The Phase-A Daimon host never installs a local package: it copies a separately released generic image by immutable digest and verifies that image's capability receipt. The actual `npm pack`-into-build-context step is compiler-level I/O and lives in `src/compiler/containerPackageOverrides.ts`; this folder only owns recipe shaping, never packing or engine installation.

`localDaimonAuthority.ts` is the only local Daimon image seam. It accepts only
an attested `127.0.0.1:<port>` registry authority and is activated
only by an absolute path in `SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY`, accepts
the exact v2 non-production schema, and requires the fixed loopback registry
repository by OCI manifest digest plus a capability-receipt SHA-256. Raw image
or receipt environment overrides fail closed. With no identity path,
`container.ts` uses the checked-in `runtimes.yaml` digest and receipt unchanged.

`types.ts`'s `ContainerTarget` carries an optional `engineByNodeId?: Record<string, string>` passthrough slot for adapters that disclose a native engine kind per compiled node. The Pi adapter reports generated Pi engine kinds; the Daimon adapter reports its public `codex`/`grok`/`agy` engine intents. `src/compiler/containerArtifactsPlans.ts`/`containerArtifacts.ts` thread the map unchanged into `ContainerRuntimeInstanceReport.engine_by_node_id` (`src/report/types.ts`). Other adapters omit it.

`MNEME_RECALL_MODE` (mneme's own `MNEME_RECALL_MODE_ENV`, see `ecosystem/mneme/src/runtime/recallMode.ts`) is the B70 memory recall-mode ablation knob (`on`/`off`/`shuffled`). It follows the same trust shape as `NOOPOLIS_RUN_ID` and `MNEME_OLLAMA_BASE_URL`: a harness/container-injected environment variable, read directly inside mneme's `JsonlMemoryRuntime` constructor, never a config field this package lowers, never a model-facing tool argument, and never model-writable. That is intentional — Daimon and the Pi prelude (`appPreludeSource.ts`'s `createMemoryRuntimeOptions`) pass no `recallMode` field, so a generated container that never sets the env var always resolves to `on`, and this folder needed zero changes to add the ablation knob. Only an operator's own process env, or `src/runtime/pi/appCliSource.test.ts`'s "wired to the real @noopolis/mneme memory runtime" case (which sets it directly, in-process, per mode) may set it.

`RuntimeAuthPreparationInput.authProfile` (`types.ts`) is `ResolvedAuthProfile | null`, not required. `src/compiler/runProjectAuth.ts`'s `prepareRuntimeAuthMounts` calls every adapter's `prepareRuntimeAuth` unconditionally — it no longer short-circuits to empty mounts just because `spawnfile run`/`up` was invoked without `--auth-profile`. This matters because not every adapter mount depends on the Spawnfile-managed auth profile: the Pi adapter's optional grok/codex/antigravity CLI-home staging (`src/runtime/pi/runAuth.ts`'s `collectOptionalCliHomeMounts`) reads straight from the host's `~/.grok`/`~/.codex`/antigravity directories (or their `*_HOME` env overrides) regardless of any profile, mirroring `src/e2e/officeSim.ts`'s `stageGrokHome` test harness. Before this, a composed real-engine deployment invoked with no `--auth-profile` (e.g. `simfile`'s driver, which is charter-forbidden from handling auth at all) skipped this staging entirely, so a `pi` instance declaring `engine: grok` got a full grok-home tree with no `auth.json` and every grok turn failed at auth. Each adapter's `prepareRuntimeAuth` must treat a `null` `authProfile` as "no profile-derived imports available," never throw — `preparePiRuntimeAuth`, `prepareOpenClawRuntimeAuth`, and `preparePicoClawRuntimeAuth` all null-safe their `input.authProfile?.imports[...]` lookups for exactly this reason.

## Rules

- Adapters receive resolved nodes, not raw manifests.
- Keep runtime-specific behavior isolated here.
- Share only the adapter contract, not runtime-specific implementation details.
