---
title: Runtimes Overview
description: What runtimes are, compatibility requirements, the runtime registry in runtimes.yaml, and how blueprints work.
---

Spawnfile compiles agent manifests to **runtime-specific output**. A runtime is an external system that hosts agents as long-lived services. The compiler uses runtime adapters to translate portable Spawnfile declarations into the configuration and workspace files each runtime expects.

## What Makes A Runtime Compatible

A runtime is **Spawnfile-compatible** when it satisfies all of these requirements:

1. **It runs as a long-lived service or daemon.** Spawnfile targets autonomous agent runtimes, not tools invoked per task.
2. **It uses a markdown workspace as a first-class agent surface.** The runtime reads Markdown documents to define agent identity, behavior, and context.
3. **It exposes a declarative configuration surface** that a compiler can emit (JSON config, TOML config, etc.).

Systems that are manually invoked per task (coding assistants, chat CLIs, one-shot agent shells) are not Spawnfile targets, even if they use workspace conventions or Markdown control files.

## The Runtime Registry

The runtime registry is a YAML file at the repository root: `runtimes.yaml`. It declares which runtimes the project knows about, pins the version each adapter was written against, and tracks lifecycle status.

### Schema

```yaml
runtimes:
  <name>:
    remote: <git clone URL>
    ref: <pinned git ref>
    default_branch: <main | master>
    status: <active | exploratory | deprecated>
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `remote` | yes | Git clone URL for the runtime repository |
| `ref` | yes | Pinned git ref -- the latest stable release tag |
| `default_branch` | yes | The repository's primary branch name |
| `status` | yes | Lifecycle status in the Spawnfile project |

### Status Values

| Status | Meaning |
|--------|---------|
| `active` | Has a working compiler adapter in `src/runtime/<name>/` |
| `exploratory` | Research exists but no adapter yet |
| `deprecated` | Was previously active, adapter no longer maintained |

## Active Runtimes

These runtimes have working adapters:

1. **[OpenClaw](/runtimes/openclaw/)** -- JSON config, rich workspace layout, MCP through mcporter bridge, multi-agent routing.
2. **[PicoClaw](/runtimes/picoclaw/)** -- JSON config, workspace-first model, first-class MCP surface, spawned subagents.
3. **[TinyClaw](/runtimes/tinyclaw/)** -- Multi-agent/multi-team runtime with the strongest native team support.

## Exploratory Runtimes

These runtimes have a confirmed config + markdown workspace model but no adapter yet:

4. **[NullClaw](/runtimes/nullclaw/)** -- JSON config, OpenClaw-compatible structure, stdio-first MCP, delegate agents.
5. **[ZeroClaw](/runtimes/zeroclaw/)** -- TOML config, strong auth story, named delegate sub-agents.

## Version Pinning

### Why Pin

Runtime APIs, config formats, and CLI interfaces change across versions. An adapter written against one version may not produce valid output for a different version. Pinning makes this explicit.

### What To Pin

The `ref` field should point to the latest stable release tag. Stable means no pre-release suffixes like `-alpha`, `-beta`, `-rc`, or `-dev`. If a runtime only publishes pre-release tags, pin the most recent one and note it.

### When To Bump

Bump `ref` when:
- A new stable release is available and the adapter has been verified against it
- The adapter is being updated to support new features from a newer version

Do not bump `ref` speculatively. The pin represents "the adapter works at this version."

### Sync Script

`scripts/runtimes.sh` reads `runtimes.yaml` and clones or checks out each runtime at its pinned ref:

```bash
./scripts/runtimes.sh              # sync all runtimes
./scripts/runtimes.sh openclaw     # sync one runtime
```

Cloned repositories live in `runtimes/` at the repo root (gitignored). These are for research, blueprint generation, and adapter development. The `spawnfile compile` command does not require local runtime clones.

## Blueprints

Blueprints are frozen reference layouts that capture the expected config and workspace structure for each compatible runtime at its pinned version. All five supported runtimes share the core pattern: a JSON or TOML config file plus separate markdown docs in a workspace directory.

Blueprints serve as the ground truth for adapter implementation. They document exactly what files the adapter should emit and where they should be placed for a given runtime version.

## Portable Surface

Spawnfile defines a portable surface that adapters attempt to preserve across runtimes:

- Markdown document roles (identity, soul, system, memory, heartbeat, extras)
- Skills with `SKILL.md`
- MCP server declarations
- Runtime binding and execution intent
- Team structure and shared surfaces
- Communication surfaces (Discord in v0.1)

If a runtime cannot preserve part of this surface exactly, the adapter reports `supported`, `degraded`, or `unsupported` according to the compile policy. The compile report always records these capability outcomes so you know what was preserved and what was lost.

## Quick Compatibility Matrix

| Runtime | Docs | Skills | MCP | Models | Sandbox | Teams | Discord |
|---------|------|--------|-----|--------|---------|-------|---------|
| OpenClaw | Strong | Strong | Bridge | Strong | Strong | Routed sessions | Full (pairing, allowlist, open) |
| PicoClaw | Strong | Strong | Strong | Strong | Strong | Spawned subagents | Partial (open, user allowlists) |
| TinyClaw | Strong | Present | No clear surface | Strong | Strong | Native teams | Pairing only |
| NullClaw | Strong | Strong | stdio-first | Strong | Strong | Delegate agents | -- |
| ZeroClaw | Strong | Strong | Mixed | Strong | Strong | Delegate sub-agents | -- |
