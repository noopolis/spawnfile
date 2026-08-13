# Deployment Guide

This folder owns deployment records and deployment-manager helpers.

## Structure

```text
src/deployment/
├── index.ts         # Barrel exports
├── names.ts         # Deployment name validation and record path helpers
├── target.ts        # Docker target endpoint fingerprint helpers
├── dockerLabels.ts  # Docker label construction for managed units
├── dockerInspect.ts # Bounded Docker container inspection for status --live
├── dockerLogs.ts    # Bounded Docker log collection with redaction for status --logs
├── dockerProbeGateway.ts # Manager-mediated artifact reads and ephemeral same-image network-namespace health probes
├── dockerRecover.ts # Docker label recovery for context-backed remote status
├── buildImageCacheStore.ts # Strict, atomic Spawnfile-home cache for verified Docker image builds
├── record.ts        # Deployment record schema, parser, reader, and writer
├── dockerManager.ts # Docker deployment record assembly
├── artifactsExportTypes.ts # `spawnfile.export-index.v1` zod schema/type + parser
├── artifactsExportPlan.ts  # Pure planning: which durable files to export from a compile report (no Docker/IO)
├── artifactsExportDocker.ts # Low-level `docker cp`/volume-read Docker calls for artifacts export
├── artifactsExport.ts # `spawnfile artifacts export` orchestrator: resolves the deployment + compile report, egresses planned files, writes export-index.json
├── upReceiptTypes.ts # `spawnfile.up-receipt.v1` zod schema/type + parser
├── downReceiptTypes.ts # `spawnfile.down-receipt.v1` zod schema/type + parser
├── dockerTeardown.ts # Low-level `docker rm -f`/`docker volume rm -f` Docker calls for `spawnfile down`
├── downDeployment.ts # `spawnfile down` orchestrator: record-driven teardown + the export-before-teardown guard (refuse/force/export-to)
├── lifecycleCompletionStore.ts # Strict lifecycle record reads and immutable publication
├── lifecycleCompletionPaths.ts # Lifecycle completion path and record-name validation
└── lifecycleCompletionRoot.ts # Anchored lifecycle-store root creation and revalidation
```

## Rules

- Keep deployment records free of secrets. Paths are allowed only for local operator metadata.
- Docker labels must contain identifiers only, never local paths or secret-bearing values.
- Records are written only after a detached deployment has successfully started.
- Build-image cache entries live under the Spawnfile home, are strict-schema
  parsed, mode 0600, and best-effort only: cache corruption or I/O failure must
  never fail a compile/build.
- Keep manager-specific logic here; CLI handlers should only pass user options through.
- Deployment owns lifecycle, records, readiness metadata, diagnostics, and
  artifact egress. It must not proxy live provider traffic, expose provider
  send/read/transcript commands, or use container exec as an application data
  plane. Gateway exec is artifact/diagnostic-only; HTTP uses an ephemeral
  same-image helper in the target container's network namespace; see
  `../../specs/ECOSYSTEM_RUNTIME_BOUNDARIES.md`.
- `organization_ready` proves that the recorded unit exists, is running, has
  not restarted, and matches its immutable deployment identity; every managed
  network's public `/healthz` succeeds; Moltnet node configs match their
  compile-time digests and schema; and world bindings match their compile-time
  digest and member assignments. It deliberately no longer proves network-id
  authenticity, room existence, room membership against compiled topology,
  agent registration/attachment/connection, direct-message capability, that
  any attachment credential works, or that provider traffic can flow. B149
  restores authenticated attachment verification through the provider-owned
  client.
- Live inspection helpers should normalize Docker failures into status summaries instead of throwing for missing containers.
- `run_id` on a deployment record (`record.ts`) is optional and sourced only from
  `process.env.NOOPOLIS_RUN_ID` at record-write time (`dockerManager.ts`'s
  `writeDockerDeploymentRecordForRun`) — never guessed or recomputed. It exists so
  `spawnfile artifacts export --run-id <id>` can find the deployment a given run compiled,
  without adding a second source of truth for the run id.
- `artifacts export` reads from the deployment's containers + named volumes. Every planned
  source is volume-sourced as of Piece 4b (moltnet-causal + mneme banks already were;
  daimon per-agent telemetry joined them — `daimonTelemetryArtifacts.ts`), so `spawnfile
  down` (without `--volumes`) MAY now run BEFORE `spawnfile artifacts export` — this is the
  real relaxation of the export-before-teardown invariant (Decision 21) Piece 4b unlocks.
  `artifactsExport.ts` only preflight-checks the recorded container still exists (and fails
  loudly — never a silent empty export — when it does not) IF the plan actually contains a
  `kind: "container"` file; today that only happens for a legacy pre-Piece-4b compile
  report (`artifactsExportPlan.ts`'s `planDaimonFiles` container-cp fallback). Per-file
  misses inside an otherwise-live deployment (e.g. a bank that never wrote `events.jsonl`)
  are not that failure; each planned file in `artifactsExportPlan.ts` carries its own
  `optional` flag for exactly that distinction.
- `artifactsExportDocker.ts`'s volume egress never pulls a new image: it reads a named
  volume by `docker create`-ing (never starting) a throwaway container from the
  deployment's own already-local `unit.image_tag`, `docker cp`s the one file out, then
  removes the throwaway container.
- `artifactsExport.ts` stamps `export_index` (record.ts, optional) onto the deployment
  record it just exported, once `spawnfile.export-index.v1` is written successfully.
  `downDeployment.ts` reads that SAME field to enforce the export-before-teardown
  invariant — the two commands never need a second, out-of-band way to agree that a run's
  artifacts are already safe to discard the container for.
- `spawnfile down` (`downDeployment.ts`) is record-driven, like `artifacts export`: resolve
  the deployment record, then act on its recorded units/target. It refuses to remove
  containers when `export_index` is absent, unless the caller passes `--force`
  (deliberately discard un-exported artifacts) or `--export-to <dir>` (run the export
  first, then proceed). Container removal is `docker rm -f` (idempotent — an already-gone
  container counts as removed); named volumes are retained by default and only removed
  with an explicit `--volumes`. A partial failure (one unit's container won't remove, one
  volume won't remove) is collected into the receipt's `errors` array, never thrown —
  `spawnfile down --json` always returns a `spawnfile.down-receipt.v1`, even on partial
  failure.
- **Flagged, not yet acted on:** now that moltnet-causal, mneme, and daimon telemetry are
  ALL durable-volume-backed (Piece 4b), the `down` export-guard above (refuse without
  `export_index`/`--force`/`--export-to`) could in principle relax further, since a plain
  `docker rm` (no `--volumes`) no longer risks losing any of them — `spawnfile artifacts
  export` can always run afterward. It is deliberately KEPT as belt-and-suspenders for now:
  the guard is about the run-dir ASSEMBLY step wanting export to happen before an operator
  eventually passes `--volumes` and deletes the durable stores for good, which is a
  separate concern from "did teardown lose anything." Revisit only alongside a real
  decision about when volumes get GC'd.
- `lifecycleCompletion.ts` owns only Spawnfile's durable machine-command completion
  records. It binds a caller-provided invocation id to the exact operation, correlation,
  request policy, and JSON outcome before stdout is emitted. It never scans Docker or a
  provider on lookup, and it does not recover a provider process that crashed internally.
