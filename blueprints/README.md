# Blueprints

Frozen reference layouts for each runtime at the version pinned in `runtimes.yaml`.

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

## Incompatible Runtimes

These were evaluated but are fundamentally incompatible with Spawnfile's config + markdown workspace model:

- **IronClaw** — env-vars-only orchestrator/worker system, no agent config files
- **NanoClaw** — code-driven via Claude Code skills, no declarative config surface
See `specs/research/RUNTIME-NOTES.md` for the full research on each.

## Adapter Candidates

- **OpenFang** — current releases expose declarative config and agent templates, but Spawnfile has not mapped the adapter contract yet.
- **Hermes Agent** — tracked as exploratory; config, workspace, and skill surfaces need research before an adapter.
- **OpenCode** — tracked as exploratory; install and long-running agent surfaces need research before an adapter.
