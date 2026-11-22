# Runtime Guide

This folder owns runtime adapters and runtime option validation.

## Structure

```text
src/runtime/
├── index.ts               # Barrel for adapter registry exports
├── scaffoldAssets.ts      # Shared loader for runtime-owned init template assets
├── copyScaffoldAssets.ts  # Copies each adapter's declared package-assets.json inputs
├── adapterPublic.ts      # Versioned SDK for external adapter modules
├── adapterBase.ts        # Base class with standard pinned install recipes
├── types.ts               # Shared adapter contract types
├── wiringTypes.ts          # Optional Moltnet, memory, and readiness capabilities
├── wiringSelection.ts      # Adapter capability lookup for shared consumers
├── portableMoltnetWiring.ts # ACP stdio and workspace layout helpers
├── hostTypes.ts            # Optional native host build and launch contracts
├── hostSelection.ts        # Select registered host capabilities and launch wrapper
├── operations.ts          # Optional live drain, readiness, recording, artifact and usage contracts
├── trainingTypes.ts       # Optional live training, provider, login and credential hooks
├── nativeTraining.ts      # Typed native session driver and public training capability
├── nativeTrainingRun.ts   # Connects project training and its configured judges
├── nativeTrainingSubject.ts # Turns, cancellation, replies and evidence coverage
├── nativeTrainingContainer.ts # Per-trial project, container and storage lifecycle
├── nativeTrainingFiles.ts # Transfer of selected inputs and outputs
├── trainingSelection.ts   # Runtime and credential capability selection
├── common.ts              # Shared lowering helpers used by adapters
├── mnemeMcp.ts            # Shared Mneme MCP lowering plus the durable memory mount authority
├── container.ts           # Compatibility entrypoint for adapter-owned container install recipes
├── containerRecipe.ts     # Shared recipe input and image copy helpers
├── install.ts             # Registry install selection normalization
├── containerPackageOverrides.ts # Runtime install npm package override contract consumed by container.ts
├── registry.ts            # Bundled adapter registration, invocation-scoped plugins and lookup
├── loadAdapterPlugins.ts  # Resolve-then-import of explicit or declared adapter ESM modules
├── usageTypes.ts          # Normalized usage row types
├── usageLedger.ts         # Usage aggregation and historical parser exports
├── usageLedgerRead.ts     # Shared artifact `cat` reader distinguishes absent/unreadable; usage merges two generations
├── usageRequestLedger.ts  # Historical parser exports for per-request rows
├── scheduleUtils.ts       # Shared duration schedule helpers for runtime lowering
├── daimon/                # Public Daimon organization-host adapter
├── openclaw/              # OpenClaw adapter implementation
├── picoclaw/              # PicoClaw adapter implementation
├── common.test.ts         # Shared runtime helper tests
└── registry.test.ts       # Adapter registry tests
```

Each adapter owns its registration, init scaffold, install hints, native install recipe, static package assets, and image build context. Image builds read each adapter's `image/build.json` without loading runtime code. Keep shared adapter helpers in `common.ts`.

Host hooks declare any native image wrapper, privilege boundaries, credential preparation,
generated secrets and volume binding rules. The compiler and deployment own assembly,
mount reservations, and activation. A runtime can omit every host hook.

Adapters expose native chat and memory wiring through `RuntimeAdapter.wiring`.
The compiler asks for the selected adapter's Moltnet client layout, bridge
config, and required release capability. `createAcpStdioWiring` preserves each
argument as a string array and requires an authenticated `acp-bridge` release.
An explicit local Moltnet build can prove and stamp that capability.

`mnemeMcp.ts` provides the shared Mneme durable mount rule. Adapters use it when
selecting native memory configuration and describing a bank to the compiler.
`src/compiler/memoryArtifacts.ts` uses the adapter's mount path to allocate the
volume. An in-process Mneme home must use the same path as its volume.

Adapters select their native skill discovery roots. The shared `createSkillFiles` helper emits the same skill into each requested root. Daimon owns `DAIMON_SKILL_ROOTS` and its broker provisions declared skills into its worker home.

`common.ts` also owns the `NOOPOLIS_RUN_ID` container env constant (`NOOPOLIS_RUN_ID_ENV` / `resolveNoopolisRunId`); `container.ts` reads it via `createRuntimeContainerEnv` and stamps it into every generated `RuntimeInstallRecipe.env` so every authority container agrees on one run id for causal event envelopes (see `specs/CAUSAL.md`). Never read `run_id` or `principal_id` from model output here.

`common.ts` additionally exports `ensureNoopolisRunId(env = process.env)`: the one place a run id is ever generated. It returns the host-provided value untouched when `resolveNoopolisRunId` already finds one, otherwise it generates a fresh id (`run-<hex uuid>`) and stamps it onto `env` before returning it. It is exported through this folder's barrel (`index.ts`) so `src/compiler/runProject.ts` and `src/compiler/upProject.ts` can call it once, at the top of their `run`/`up` execution functions, before invoking `compileProject`/`buildProject` — never from inside `compileProject.ts`/`buildProject.ts` themselves, which must stay deterministic functions of whatever is already in the host env. `src/e2e/officeSim.ts` calls it too, since that harness builds a container directly rather than going through `runProject`/`upProject`. Without this, a host that never sets `NOOPOLIS_RUN_ID` (a bare `spawnfile up`, or an E2E harness) leaves `createRuntimeContainerEnv` with nothing to stamp, and moltnet's `causal.jsonl` capture ends up empty even though mneme/daimon still emit under their own `"unset-run"` fallback.

`containerPackageOverrides.ts` defines the `RuntimeContainerPackageOverrides` contract (`packageName -> { filename }`) for opt-in package staging. The Phase-A Daimon host never installs a local package: it copies a separately released generic image by immutable digest and verifies that image's capability receipt. The actual `npm pack`-into-build-context step is compiler-level I/O and lives in `src/compiler/containerPackageOverrides.ts`; this folder only owns recipe shaping, never packing or engine installation.

`daimon/localDaimonAuthority.ts` is the only local Daimon image seam. It accepts only
an attested `127.0.0.1:<port>` registry authority and is activated
only by an absolute path in `SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY`, accepts
the exact v3 non-production schema, and requires the fixed loopback registry
repository by OCI manifest digest plus a capability-receipt SHA-256. Raw image
or receipt environment overrides fail closed. With no identity path,
`daimon/install.ts` uses the checked-in `runtimes.yaml` digest and receipt unchanged.

`types.ts`'s `ContainerTarget` carries an optional `engineByNodeId?: Record<string, string>` passthrough slot for adapters that disclose a native engine kind per compiled node. The Daimon adapter reports its public `codex`/`grok`/`agy` engine intents. `src/compiler/containerArtifactsPlans.ts`/`containerArtifacts.ts` thread the map unchanged into `ContainerRuntimeInstanceReport.engine_by_node_id` (`src/report/types.ts`). Other adapters omit it.

`RuntimeAuthPreparationInput.authProfile` (`types.ts`) is `ResolvedAuthProfile | null`. Each adapter must treat null as no imported credentials.

## Registration

Bundled adapters export `adapter` through their folder's `registration.ts`.
The build generates static imports from those declarations and preserves historical
exports from each registered adapter's `legacyExports.json`. Removing a
registration also removes its compatibility exports from the generated files.
When no recording codec is bundled, `legacyRecordingUnavailable.ts` keeps the
historical consumer APIs typed and refuses to read retained history. Project commands load external adapters from the root Spawnfile's
`adapters` map. The repeatable `--adapter` flag can also load modules for one
invocation and takes precedence for the same runtime name. Each invocation has
its own registry.

## Rules

- Adapters receive resolved nodes, not raw manifests.
- Keep runtime-specific behavior isolated here.
- Share only the adapter contract, not runtime-specific implementation details.

Native usage formats and paths live with their adapters. Live readers invoke
the registered parser and read bound. The legacy parser exports remain callable.

Daimon's Grok broker is the single sealed usage writer, and a replayed turn may
re-append its sealed rows. `usageLedger.ts` therefore dedupes every
`turn-usage.v1` row by its `turn` key (`dedupeUsageRecordsByTurn`) in parsing,
across both ledger generations (`usageLedgerRead.ts`), and inside every
aggregate; rows without a key are kept. It reads the broker's additive fields
only from Daimon's closed vocabularies — `limit_reason`, `model`, `outcome`,
`estimated_requests` — dropping a malformed optional field rather than the
row's spend. Rows with `estimated_requests` carry a conservative charge for
requests whose provider response had no valid usage; `spawnfile usage` marks
them `~` and says so, never presenting them as measured.

`RuntimeAdapter.preflightAgent(node, nodeId)` (`types.ts`) is optional and
side-effect free: it throws a `SpawnfileError` for whatever that adapter's
compile would refuse for one agent, without emitting anything.
`src/compiler/preflightCompilePlan.ts` runs it for every agent during
`spawnfile validate` and reports every refusing agent by node id. Keep it in
step with `compileAgent`/`createContainerTargets` by calling the same check
functions, never a copy.
- Container targets may publish `agentPathsByNodeId` with the same placeholders as configuration; compiler expansion reports these facts for offline consumers.

`trainingPublic.ts` is the selected package CLI integration barrel. It delegates
to `trainingCli.ts` for runtime composition without exposing its internal `main`.

`daimon/daimonInstall.ts` owns the receipt/manifest verification and CLI/broker
installation commands used by `daimon/install.ts`. Keep this one authority; never
weaken verification. Its adjacent tests execute verification
against matching, missing and mismatched install files.

Training subject registration is optional. Registry entries expose an async
`training.subject()` loader; only `trainingSubjects.ts` resolves it, so ordinary
compiler and CLI startup never evaluates training adapters. The scoped training
typecheck/build also covers the moved adapters and supplies their strict checks.
`trainingCli.ts` is the import-safe training composition and executable integration entry.
Host consumers pass canonical context directly; integrations may pass the context-file flag.
`trainingSubjects.test.ts` owns default factory composition coverage.

Training provider composition lives in `trainingComposition.ts` and loads registered adapter contributions. `trainingProviders.ts` and `trainingGraderProviders.ts` assemble the provider data. Engine inference providers live under their runtime, and neutral built-ins remain in the core. Training implementations import contracts or the public core barrel, never private helpers. Registry training declarations include adapterId and engine vocabulary; repair admission checks the selected registration.

trainingRegrade.ts composes the regrade of recorded outputs: the manifest, the registered judge providers, one result file per output and the REGRADE report. It is a training composition entry point (allowed by the training boundary test) and never creates the booted run; the CLI binds the run's judges around it.
