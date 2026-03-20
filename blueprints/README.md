# Blueprints

Frozen reference layouts for each runtime at the version pinned in `runtimes.yaml`. Generated mechanically by `./scripts/blueprints.sh`.

Each blueprint shows exactly what a runtime expects when you set up a bot — config files, workspace structure, doc locations, skill directories.

## Regenerating

```bash
./scripts/blueprints.sh              # all runtimes
./scripts/blueprints.sh openclaw     # one runtime
```

On a version bump: update `runtimes.yaml` → run `./scripts/runtimes.sh` → run `./scripts/blueprints.sh` → diff the output.

## Runtimes

| Runtime | Type | Config | Workspace Docs | Source |
|---------|------|--------|----------------|--------|
| OpenClaw | npm | `openclaw.json` | AGENTS, BOOTSTRAP, HEARTBEAT, IDENTITY, SOUL, TOOLS, USER | `openclaw onboard` |
| PicoClaw | Go | `config.json` | AGENTS, SOUL, USER, IDENTITY, HEARTBEAT, memory/MEMORY | `config.example.json` |
| TinyClaw | npm | `settings.json` | AGENTS, SOUL, heartbeat (per-agent dir) | `defaults.mjs` |
| NullClaw | Zig | `config.json` | AGENTS, SOUL, IDENTITY | `config.example.json` |
| ZeroClaw | Rust | `config.toml` | AGENTS, SOUL, IDENTITY | `config-reference.md` |

## Incompatible Runtimes

These were evaluated but are fundamentally incompatible with Spawnfile's config + markdown workspace model:

- **IronClaw** — env-vars-only orchestrator/worker system, no agent config files
- **NanoClaw** — code-driven via Claude Code skills, no declarative config surface
- **OpenFang** — inline system_prompt in TOML, no markdown workspace

See `specs/research/RUNTIME-NOTES.md` for the full research on each.
