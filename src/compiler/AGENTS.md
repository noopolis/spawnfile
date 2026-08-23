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
├── containerEntrypointShell.ts # Shell quoting, recipe env, and CLI credential materialization helpers
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
