# CLI Guide

This folder owns user-facing command parsing and process exit behavior.

## Structure

```text
src/cli/
├── index.ts        # Executable Node entrypoint
├── runCli.ts       # Top-level Commander setup and shared CLI types
├── capabilitiesCommand.ts # Read-only public capability command registration
├── capabilitiesReceipt.ts # Strict Spawnfile capability receipt
├── composedLifecycleContractSet.ts # Closed machine command/contract inventory
├── evidenceExportHelperCommand.ts # Local helper construction command
├── compileBuildCommands.ts # `compile` and `build` command registration
├── lifecycleCommands.ts # Thin lifecycle/compile/build/run/publish/up/down registration composition
├── lifecyclePlanningCommands.ts # Durable lifecycle plan and lookup command registration
├── runPublishCommands.ts # `run` and `publish` command registration
├── upCommand.ts # Project/image `up` registration and machine-lifecycle receipt flow
├── upLifecycleRecovery.ts # Exact detached-container recovery for machine project `up`
├── statusCommand.ts # Status command orchestration and registration
├── statusCommandOptions.ts # Status option parsing, handler contracts, and output helpers
├── statusCommandLive.ts # Home-store and live-deployment status collection
├── usageCommand.ts # `spawnfile usage` registration, windowing, and rendering
├── usageCommandLive.ts # Usage ledger transport: deployment selection + probe-gateway reads
├── modelCommands.ts # `spawnfile model ...` command registration
├── runtimeCommands.ts # `spawnfile runtime ...` command registration
├── surfaceCommands.ts # `spawnfile surface ...` command registration
├── artifactsCommands.ts # `spawnfile artifacts export` command registration
├── targetCommands.ts # `spawnfile target ...` command registration
├── targetEvidenceHelperResolution.ts # Target-local evidence helper request derivation
├── targetConfigPreparedPlan.ts # Strict private prepared-plan file transport
├── targetComposedPreparationCommand.ts # One aggregate composed-run preparation command
├── targetWorldReadinessCommand.ts # public world-only readiness query registration
├── targetWorldClockCommand.ts # public post-activation world-clock query registration
├── targetDefaultWorldReadiness.ts # production exact-world readiness lowering
├── targetDefaultWorldClock.ts # production activated-world clock lowering
├── targetDefaultWorldQueries.ts # minimal shared read-only world query session
├── targetDefaultHandlers.ts # Closeable production target handler sessions and read-only queries
├── targetDefaultHandlerFactory.ts # Mutation handler validation and provider operation composition
├── targetDefaultAuthorities.ts # Production target authority-session assembly
├── targetDefaultJournalAuthority.ts # Exact target journal identity and resolver authority
├── targetLookupCommands.ts # provider-neutral lookup registration and production loader
├── targetLookupCli.ts # minimal production lookup entry point
├── targetOperationLookup.test.ts # read-only target lookup command proof
├── viewCommand.ts  # `spawnfile view` command registration and render option mapping
├── viewCommand.test.ts # `spawnfile view` behavior tests
└── runCli.test.ts  # General CLI behavior tests
```

`index.ts` should stay minimal. `runCli.ts` owns command wiring, while real work stays in compiler modules.

## Rules

- Keep command handlers small.
- Push parsing, validation, and compile behavior into compiler modules.
- Normalize errors here so the rest of the code can throw typed errors.
- Keep the CLI testable by isolating parsing from direct process exit handling.
- Spawnfile CLI commands must not relay live provider traffic. Moltnet
  `send`, `read`, subscriptions, cursors, and transcript operations belong to
  Moltnet-owned clients, as required by
  `../../specs/ECOSYSTEM_RUNTIME_BOUNDARIES.md`.
