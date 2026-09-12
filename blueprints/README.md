# Blueprints

Frozen upstream reference layouts for OpenClaw and PicoClaw at the versions
pinned in [`runtimes.yaml`](../runtimes.yaml). These files document upstream
defaults; the compiler does not read this directory during a build.

Each blueprint shows exactly what a runtime expects when you set up a bot — config files, workspace structure, doc locations, skill directories.

## Updating

On a version bump, update `runtimes.yaml`, regenerate the runtime's canonical
configuration with the pinned upstream CLI or reference config, and diff the
captured layout. The blueprint change and adapter verification belong in the
same review.

## Runtimes

| Runtime | Type | Config | Workspace Docs | Source |
|---------|------|--------|----------------|--------|
| OpenClaw | npm | `openclaw.json` | AGENTS, BOOTSTRAP, HEARTBEAT, IDENTITY, SOUL, TOOLS, USER | `openclaw onboard` |
| PicoClaw | Go | `config.json` | AGENTS, SOUL, USER, IDENTITY, HEARTBEAT, memory/MEMORY | `config.example.json` |

## Compiler-generated runtimes

Daimon has no upstream onboarding scaffold to freeze here. Spawnfile's
[Daimon adapter](../src/runtime/daimon/AGENTS.md) generates
`daimon-organization-runtime.json` and each agent's workspace from the resolved
organization. Its [configuration tests](../src/runtime/daimon/config.test.ts)
and [adapter tests](../src/runtime/daimon/adapter.test.ts) verify the versioned
runtime contract, workspace documents, and launch artifacts. A separate
hand-maintained blueprint is not a compile input or a missing runtime dependency.

The legacy Pi adapter likewise generates its application and configuration;
see its [working guide](../src/runtime/pi/AGENTS.md).

## Incompatible Runtimes

These were evaluated but are fundamentally incompatible with Spawnfile's config + markdown workspace model:

- **IronClaw** — env-vars-only orchestrator/worker system, no agent config files
- **NanoClaw** — code-driven via Claude Code skills, no declarative config surface
See [runtime research](../specs/research/RUNTIME-NOTES.md) for the full research on each.

## Adapter Candidates

- **OpenFang** — current releases expose declarative config and agent templates, but Spawnfile has not mapped the adapter contract yet.
- **Hermes Agent** — tracked as exploratory; config, workspace, and skill surfaces need research before an adapter.
- **OpenCode** — tracked as exploratory; install and long-running agent surfaces need research before an adapter.
