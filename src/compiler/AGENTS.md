# Compiler Guide

This folder owns graph resolution, effective configuration, compile planning, and output emission.

## Structure

```text
src/compiler/
├── index.ts                    # Barrel for compiler-facing exports
├── types.ts                    # Internal compiler plan and resolved-node types
├── helpers.ts                  # Deterministic helper utilities
├── compilePlanHelpers.ts       # Fingerprints and shared validation used by graph resolution
├── agentSurfaces.ts            # Portable agent-surface resolution helpers
├── interactiveSurfaceScopes.ts # Shared helpers for runtime validation of interactive surface scope counts
├── surfaceDefinitions.ts       # Shared surface-edit command types and manifest-shape helpers
├── surfaceSupport.ts           # Runtime surface compatibility checks during graph resolution
├── surfaces.ts                 # Resolved docs, skills, and shared-surface merging
├── buildCompilePlan.ts         # Manifest graph walk and plan construction
├── buildCompilePlanAgent.ts    # Shared referenced/inline agent-node resolution
├── buildCompilePlanTraversal.ts # Graph traversal + recursion by manifest kind
├── buildCompilePlanTraversalHelpers.ts # Shared traversal helper primitives
├── compileProject.ts           # Adapter execution and output/report emission
├── compileProjectReports.ts    # Node report augmentation derived from compile support
├── compileProjectSupport.ts    # Shared compile-time artifact injection and file writing helpers
├── dockerBuildContext.ts       # Emitted Docker ignore policy, surviving-file inventory/digest, and COPY/ADD safety checks
├── dockerBuildSkip.ts          # Bounded image inspection and ordered context-cache skip decision
├── containerArtifactSummaries.ts # Container report summaries for distribution/Moltnet output
├── containerTargetResources.ts # Per-runtime workspace resource placement for container targets
├── containerConfigEnvRender.ts # Generic JSON config-env command and entrypoint materialization rendering
├── containerEntrypointRender.ts # Generated container entrypoint orchestration
├── containerRuntimeReadinessRender.ts # Per-runtime /healthz readiness wait rendered into the entrypoint
├── containerBackedMountRender.ts # Fail-closed `require_backed_mount` guard for durable mount paths
├── containerPersistentMountCollisions.ts # Cross-source durable volume-name uniqueness check
├── containerEntrypointShell.ts # Shell quoting, recipe env, and CLI credential materialization helpers
├── containerDaimonBrokerRender.ts # Fixed Daimon broker identities, registrations, worker config, and root-launch provisioning
├── containerArtifactsPlans.ts # Environment inventory and runtime target-plan orchestration
├── containerTargetPlanResolution.ts # Per-target paths, packages, auth, secrets, and exposure resolution
├── teamRoster.ts               # Context-scoped team roster generation and diagnostics
├── runProject.ts               # `spawnfile run` docker-run planning and execution
├── runProjectDocker.ts         # Docker run process runner and detached container metadata capture
├── runProjectLifecycle.ts      # Generated run-env cleanup while preserving detached auth bind sources
├── initProject.ts              # `spawnfile init` orchestration around runtime-owned scaffolds
├── addProjectNode.ts           # `spawnfile add ...` graph-editing helpers
├── updateProjectModels.ts      # `spawnfile model ...` manifest-editing helpers
├── updateProjectRuntime.ts     # `spawnfile runtime ...` manifest-editing helpers
├── updateProjectSurfaces.ts    # `spawnfile surface ...` manifest-editing helpers
├── projectManifestGraph.ts     # Shared graph walk and inline-member rewrite helpers
├── executionDefaults.ts        # Effective execution defaults applied during graph resolution
├── moltnetRoomMemberships.ts   # Pure concrete Moltnet room membership projection
├── moltnetClientConfig.ts      # Moltnet client config emission and runtime workspace layout helpers
├── moltnetNodeConfig.ts        # Moltnet node/bridge config JSON rendering helpers
├── moltnetArtifactPaths.ts     # Moltnet artifact path, port, and volume-name helpers
├── moltnetArtifactTypes.ts     # Moltnet artifact data contracts shared by compiler modules
├── moltnetRoomPolicyCompatibility.ts # Duplicate Moltnet network/room compatibility checks
├── organizationIdentity.ts     # Public canonical organization identity surface
├── organizationIdentityGraph.ts # Internal root-team graph/path validation primitives
├── organizationExternalParticipants.ts # Nonempty participant B31 auth and intent lowering
├── moltnetBinaries.ts          # Strict stamped and authority-pinned Moltnet binary staging
├── moltnetReleaseDownload.ts   # Bounded exact-digest download for the pinned published release
├── moltnetReleaseAuthority.ts  # Parser for the checked-in version/revision/asset digest trust root
├── daimonTelemetryArtifacts.ts # Run-scoped durable volume for legacy generated-Pi telemetry
├── containerPackageOverrides.ts # Local runtime install package npm-pack staging for the container build context
├── upReceipt.ts                # `spawnfile.up-receipt.v1` builder: compiled_schedule extraction + deployment-record readback
├── view/                       # Pure compiler view models/renderers for `spawnfile view`
├── *.test.ts                   # Tests next to the implementation they cover
```

`buildCompilePlan.ts` resolves the graph. `compileProject.ts` consumes that resolved plan. Do not collapse those concerns.

## Rules

- Keep the compiler deterministic.
- Resolve and validate the graph before calling any runtime adapter.
- The compile plan is internal state, not user-authored schema.
- Emit stable output paths and reports.
- Keep Docker build reuse keyed to the complete non-ignored context digest. The
  digest deliberately retains run-scoped entrypoint content and normalizes only
  `distribution-report.json.generated_at`; `compile_fingerprint` is an
  additional cache guard, never a substitute for context content. Report the
  context listing and digest walk separately as `imageBuild.contextDigestMs`.
- Keep Spawnfile as a compiler/canonicalizer: do not add custom team routers, team-message tools, or runtime RPC mechanisms.
- Follow `../../specs/ECOSYSTEM_RUNTIME_BOUNDARIES.md`: compiler output may
  describe provider attachments and secret references, but Spawnfile must not
  implement or proxy live provider traffic, world actions, or agent cognition.
- Treat spawned runtimes as write-only. Generated files/config/secrets may be written, but runtime state must not be read back to infer identity or update rosters.
- Team contexts are emitted as generated artifacts (`.spawnfile/team-contexts/*`, `.spawnfile/rosters/*`, `.spawnfile/team-contexts.yaml`, `.spawnfile/team-contexts.md`) and surfaced through runtime system-instruction placement when available.
- Keep runtime-specific init scaffolds in `src/runtime/<name>/`, not here.
- `RuntimeInstallRecipe.env` (see `src/runtime/container.ts`, e.g. `NOOPOLIS_RUN_ID`) is threaded onto each `RuntimeTargetPlan.recipeEnv` in `containerArtifactsPlans.ts` and rendered by `containerEntrypointRender.ts` into the per-target exec-time env prefix (container RUN-time env), never into `renderDockerfile`'s build layer. It stays a per-run value sourced only from the host process env; an empty recipe env emits no var. Because it is host-global, `containerEntrypointRender.ts` also merges it across all `RuntimeTargetPlan`s and prefixes it onto the managed moltnet server/node launch lines, so a managed moltnet process started by the entrypoint carries the same run id as the runtime processes.
- `runProject.ts`'s `runProject()` and `upProject.ts`'s `upProject()` both call `ensureNoopolisRunId()` (`src/runtime/common.ts`, re-exported through `src/runtime/index.ts`) once, as the very first thing they do before calling `compileProject`/`buildProject`. This is the only place a run id is ever generated: it fills in `process.env.NOOPOLIS_RUN_ID` when the host didn't already set one, so a bare `spawnfile run`/`spawnfile up` (no host-set run id) still compiles every authority container with a shared real run id instead of leaving it unset (see `specs/CAUSAL.md`). `compileProject.ts`/`buildProject.ts` themselves are never touched by this and stay deterministic given a fixed host env — the generation is strictly a `run`/`up` execution-step concern, not a compile-step one.
- `CompileProjectOptions.runtimePackageOverrides` (`compileProject.ts`) is an opt-in, compile-time-only map of runtime install npm package name to an absolute local package directory. When set, `stageRuntimePackageOverrides` (`containerPackageOverrides.ts`) `npm pack`s each directory directly onto disk into `<outputDirectory>/container/vendor` (outside the `EmittedFile` pipeline — a `.tgz` cannot round-trip through its string `content` — mirroring how `stageMoltnetBinaries` in `moltnetBinaries.ts` stages binaries), and the resolved `packageName -> { filename }` map is threaded through `createContainerArtifacts` into `renderDockerfile`'s `createRuntimeInstallRecipe` calls (`src/runtime/container.ts`), which rewrite only that package's install spec to the vendored tarball path and add one `COPY container/vendor/` line. `buildProject.ts` forwards the same option additively. With no overrides (every standard compile), the generated Dockerfile is byte-identical to before this option existed. Callers are responsible for ensuring each override directory's `dist` is already built — see `assertRuntimePackageOverrideDistsBuilt` in `src/e2e/runtimePackageOverrides.ts`.
- `upReceipt.ts`'s `buildUpReceipt` builds `spawnfile.up-receipt.v1` (contracts.md) for
  `spawnfile up --json` from a project-path `upProject()` result. It re-derives
  `compiled_schedule` by calling `buildCompilePlan(inputPath)` again (deterministic, cheap
  — `compileProject.ts` does not retain its own `CompilePlan` past the compile step) rather
  than threading a new field through `UpProjectResult`, and reads back the deployment
  record `upProject` already wrote via `deploymentRecordPath` for `run_id`/container id
  (the same record `spawnfile artifacts export`/`spawnfile down` resolve). `readiness`
  reuses whatever signal `up` already has (a captured container id from the `docker run
  -d` invocation) — it does not add a new health probe. Its optional `engines:
  [{agent, engine}]` field (Piece 5, Slice B — schema kept `.strict()` with `engines`
  itself optional, so a pre-Piece-5 receipt still validates) comes from a NEW
  `resolveCompiledEngines(report)` in this same file, which flattens
  `report.container.runtime_instances[].engine_by_node_id` — deliberately reading the
  already-compiled report rather than re-deriving from a second `buildCompilePlan` walk
  (unlike `resolveCompiledSchedule` above), since that field is pi-adapter-owned
  (`src/runtime/pi/adapter.ts`'s `resolvePiEngine`) and this folder has no business
  recomputing pi-internal engine resolution itself. This is the disclosure ground truth for
  a `scripted` (or any non-default) pi engine, so a scripted run is visibly scripted rather
  than an invisible test-only branch.
- `memoryArtifacts.ts` emits durable memory mounts with `lifecycle:
  "exclusive-reattach"`, deliberately NOT run-scoped. `createPersistentVolumeName`
  folds `NOOPOLIS_RUN_ID` into a volume name and `ensureNoopolisRunId` mints a
  fresh id per `run`/`up`, so a run-scoped memory volume means the organization
  redeployed tomorrow remembers nothing — and no working escape hatch exists
  (`product-state clone` refuses SQLite paths; reusing yesterday's run id to
  reproduce the name would collapse two causal runs onto one `run_id`). The
  exclusive lifecycle's daemon-side reservation is a requirement here, not a
  cost: Mneme's append-only JSONL plus its SQLite index are single-writer. The
  consequence is that an organization with durable memory cannot use the
  concurrent blue/green canary workflow and must stop-and-reattach
  (`specs/CONTAINERS.md`), and two concurrent `spawnfile run` invocations of one
  project now fail with an occupancy error instead of silently getting separate
  empty banks. `daimon-grok-usage-ledger`
  (`src/runtime/daimon/config.ts`) carries the same lifecycle for the same
  reasons. An author-declared `persistence.name` is still honored verbatim.
- `memoryArtifacts.ts` also rejects two distinct banks resolving to one durable
  directory. Mneme keys a store by its runtime home and discards the declared
  filename, so `/d/a.jsonl` and `/d/b.jsonl` are one physical store with two
  writers; only banks that declare themselves identically (the same bank stated
  in an org scope and again in a nested team scope) may share a directory.
- Durable state is `exclusive-reattach`, never run-scoped. `containerTargetResources.ts`
  (workspace `kind: volume` resources) and `moltnetArtifacts.ts` (durable
  managed Moltnet `sqlite`/`json` stores and open-mode agent token directories)
  name their volumes from the plan root plus the deployment lineage, honouring
  an author-declared `name`/`persistence.name` verbatim, exactly as
  `memoryArtifacts.ts` does. Before this, `createPersistentVolumeName` folded
  `NOOPOLIS_RUN_ID` into these names AND silently discarded the author's
  explicit name whenever a run id was present, so every `spawnfile run` handed
  the organization a brand-new empty volume — a real newsroom lost its whole
  message history to a routine `docker rm` + recreate. `createPersistentVolumeName`
  now takes no name at all and is reserved for genuinely run-scoped mounts (the
  Moltnet causal log, per-network Moltnet runtime state, Pi telemetry). The
  cost is the same one durable memory already pays: an organization declaring
  any of these cannot use the concurrent blue/green canary path.
- `runProject.ts` mounts compiler-owned persistent mounts WITHOUT `volume-nocopy`.
  `createStateOwnershipCommand` writes the `.spawnfile-volume-init` bootstrap
  preimage into the image at each mount path, and both the Daimon ownership
  guard (`secureVolumeIdentity`) and `prepare_volume_resource` require it to
  accept a fresh volume; `volume-nocopy` suppresses exactly the copy-up that
  delivers it. Docker copies up only into an EMPTY volume, so a reattached
  volume is untouched. Target/secrets volumes under `src/target/*` keep their
  `volume-nocopy` — no image content backs those paths.
- Declared names are checked for uniqueness across EVERY mount source
  (`containerPersistentMountCollisions.ts`), not just within one source. A
  resource `name: X` and a store `persistence.name: X` used to compile to two
  mounts at two paths carrying one volume name, so docker mounted one host
  volume at both and their bootstrap-marker and replacement-sentinel protocols
  contradicted each other. `containerTargetResources.ts` separately rejects two
  distinct resources whose declared names collapse onto one backing path — the
  path segment derives from the name, so that silently shared one directory.
- Only an author-DECLARED name is published in the distribution report
  (`declared_volume_name`), and `consumeImageSupport.ts` honours it verbatim in
  a sourceless image deployment. A compiler-derived name is never published: it
  encodes the creator's plan root and deployment lineage and stays private to
  that host, so an image deployment re-derives its own per deployment. Without
  this, an operator who pre-created `clank-newsroom-store` and deployed the
  published image silently got a brand-new empty volume while the spec promised
  the declared name verbatim.
- `containerBackedMountRender.ts` renders a `require_backed_mount` check per
  durable mount into both the entrypoint and the Daimon root wrapper (before
  the ownership guard). It scans `/proc/self/mountinfo` for an exact mount
  point rather than comparing `stat -c %d` against the parent, because nested
  durable volumes share a host device number. The comparison uses the
  compiler-escaped path (`escapeMountInfoPath`): the kernel octal-escapes
  space/tab/newline/backslash in that field, so a declared `mount: "/var/lib/my
  store"` compiled fine and then refused to start.
  `SPAWNFILE_ALLOW_EPHEMERAL_STATE=1` opts out, but it disables the guard for
  every mount, so it is not a workaround for one bad path.
- `daimonTelemetryArtifacts.ts` retains the legacy generated-Pi telemetry mount
  layout. The Phase-A public `runtime: daimon` host has no Spawnfile telemetry
  mount or Pi implementation path; add its public activity integration only in
  a later Daimon control-plane phase.
- `runtime: daimon` lowers one strict public organization-host config, not a
  generated Pi app. Schedules, MCP declarations, and every surface except a
  compiler-owned Moltnet public-wake attachment fail closed. `runtime: pi`
  remains the only generated Pi path and owns its legacy engine/auth/MCP/
  scheduler behavior.
- Standard compiles use the published Daimon, Mneme, and authority-pinned
  Moltnet releases. Local package directories are accepted only through the
  explicit `CompileProjectOptions.runtimePackageOverrides` test/development
  seam; a checkout's `ecosystem/` directory never changes production output.
- `runProjectAuth.ts`'s `prepareRuntimeAuthMounts` no longer bails out to empty mounts when its `authProfile` argument is `null` (no `--auth-profile` was passed to `spawnfile run`/`up`). It still calls every runtime instance's adapter `prepareRuntimeAuth` (`src/runtime/types.ts`, now `authProfile: ResolvedAuthProfile | null`), because not all adapter-owned mounting depends on the Spawnfile-managed auth profile: the Pi adapter's optional grok/codex/antigravity CLI-home staging (`src/runtime/pi/runAuth.ts`) is host-credential-based and profile-independent, mirroring `src/e2e/officeSim.ts`'s `stageGrokHome` harness helper. This is what makes a bare `spawnfile up <org>` (no `--auth-profile`) stage the host's already-logged-in `~/.grok`/`~/.codex`/antigravity homes into a real-engine `pi` instance's runtime home — the gap that silently starved a composed real-engine deployment (e.g. `ecosystem/simfile`'s driver, which never passes `--auth-profile` by charter) of grok auth. `assertDeclaredModelAuthSatisfied`/`assertRunEnvironmentSatisfied` are unaffected: a project that actually declares `codex`/`claude-code` model auth methods still requires a matching `--auth-profile` to satisfy those, this only widens what runs with NO profile selected at all. Mount args built here are never persisted anywhere (not the deployment record, not the up-receipt) — they exist only as ephemeral `docker run -v` arguments for the one invocation.
- `runProjectAuth.ts` also provisions an independent random value for every missing managed-bearer Moltnet token environment binding. Explicit process/profile/env-file values still win, but generated red/blue/operator credentials stay only in the one Docker env file, are checked for distinctness, and that generated file is unlinked immediately after Docker returns the detached container id by `runProjectLifecycle.ts`. A later image-inspection or record-write failure must preserve the remaining support directory because its staged auth files may already be active bind-mount sources; only a true pre-start failure removes the whole directory.
