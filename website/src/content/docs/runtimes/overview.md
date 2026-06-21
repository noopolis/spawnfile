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

1. **[OpenClaw](/runtimes/openclaw/)** -- JSON config, rich workspace layout, MCP through mcporter bridge, native multi-agent sessions.
2. **[PicoClaw](/runtimes/picoclaw/)** -- JSON config, workspace-first model, first-class MCP surface, spawned subagents.
3. **[Daimon](/runtimes/daimon/)** -- Noopolis-native generated harness app backed by Pi, grouped team agents, subscription auth support, local model endpoints, shared workspace resources.
4. **[Pi](/runtimes/pi/)** -- compatibility alias for the Daimon runtime path.

## Exploratory Runtimes

These runtimes are tracked as adapter research targets but have no bundled adapter yet:

5. **[NullClaw](/runtimes/nullclaw/)** -- JSON config, OpenClaw-compatible structure, stdio-first MCP, delegate agents.
6. **[ZeroClaw](/runtimes/zeroclaw/)** -- TOML config, strong auth story, named delegate sub-agents.
7. **[OpenFang](https://github.com/RightNow-AI/openfang)** -- declarative config and agent templates, not mapped to a Spawnfile adapter yet.
8. **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** -- active harness candidate; config, workspace, and skill surfaces still need research.
9. **[OpenCode](https://github.com/anomalyco/opencode)** -- active coding-agent harness candidate; long-running runtime behavior still needs research.

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

Blueprints are frozen reference layouts that capture the expected config and workspace structure for each compatible runtime at its pinned version. Active and exploratory runtimes share the core pattern: a JSON or TOML config file plus separate markdown docs in a workspace directory.

Blueprints serve as the ground truth for adapter implementation. They document exactly what files the adapter should emit and where they should be placed for a given runtime version.

## Portable Surface

Spawnfile defines a portable surface that adapters attempt to preserve across runtimes:

- Markdown document roles (identity, soul, system, memory, heartbeat, extras)
- Skills with `SKILL.md`
- MCP server declarations
- Runtime binding and execution intent
- Team structure, representatives, generated team-context artifacts, and `team.networks[]`
- Communication surfaces (Discord, Telegram, WhatsApp, Slack, Moltnet, and Webhook in v0.1 alpha)

If a runtime cannot preserve part of this surface exactly, the adapter reports `supported`, `degraded`, or `unsupported` according to the compile policy. The compile report always records these capability outcomes so you know what was preserved and what was lost.

## Active Runtime Capability Matrix

Support levels:

- **Supported** -- the adapter preserves the Spawnfile declaration in the generated runtime.
- **Degraded** -- the project still compiles, but the compile report warns that runtime behavior is partial or different.
- **Rejected** -- validation fails at compile-plan time.
- **Compiler-owned** -- implemented by Spawnfile container/startup logic, then mounted or written into the runtime workspace.

### Core Manifest Surface

| Spawnfile feature | OpenClaw | PicoClaw | Daimon |
|-------------------|----------|----------|------------|
| Adapter shape | One gateway target per agent | One gateway target per agent | One generated app target for all Daimon agents in the compile graph |
| `workspace.docs` | Supported as role files under the runtime workspace | Supported as role files under the runtime workspace | Supported per concrete agent workspace, plus a harness-owned operating contract |
| `workspace.skills` | Supported under `workspace/skills` | Supported under `workspace/skills` | Supported per concrete agent workspace |
| `workspace.resources` `volume` | Compiler-owned symlink/backing directory in each runtime workspace | Compiler-owned symlink/backing directory in each runtime workspace | Compiler-owned symlink/backing directory in each concrete agent workspace |
| `workspace.resources` `git` | Compiler-owned clone/link at container startup | Compiler-owned clone/link at container startup | Compiler-owned clone/link at container startup |
| `environment.env` and `environment.secrets` | Compiler-owned env and secret materialization | Compiler-owned env and secret materialization | Compiler-owned env and secret materialization |
| `environment.packages` | Compiler-owned container package installation | Compiler-owned container package installation | Compiler-owned container package installation |
| `environment.mcp_servers` | Degraded through OpenClaw bridge path | Supported through PicoClaw MCP config | Degraded; not lowered into the generated Daimon app yet |
| `execution.sandbox.mode` | Supported through OpenClaw runtime/container workspace behavior | Supported through `restrict_to_workspace` and container workspace behavior | Degraded; container/workspace isolation only, Pi itself is not a sandbox engine |
| `subagents` | Degraded; lowered to routed sessions, not full Spawnfile parent-owned semantics | Supported through PicoClaw subagent behavior | Degraded; grouped app agents exist, but parent-owned subagent semantics are not preserved |

### Model And Schedule Surface

| Spawnfile feature | OpenClaw | PicoClaw | Daimon |
|-------------------|----------|----------|------------|
| OpenAI `api_key` auth | Supported | Supported | Supported |
| OpenAI `codex` auth | Supported | Supported | Supported |
| Anthropic `api_key` auth | Supported | Supported | Supported |
| Anthropic `claude-code` auth | Supported | Supported | Supported through Pi's Anthropic OAuth auth store |
| `custom` or `local` endpoint with `api_key` or `none` | Supported, except subscription-import auth | Supported for supported endpoint/auth combinations | Supported through generated Pi `models.json` |
| `schedule.kind: cron` | Degraded; no OpenClaw schedule store is emitted in v0.1 | Supported through `workspace/cron/jobs.json` | Degraded; the generated app only supports interval schedules |
| `schedule.kind: every` | Degraded; no OpenClaw schedule store is emitted in v0.1 | Degraded; PicoClaw lowering is cron-only in v0.1 | Supported by the generated app scheduler |
| `schedule.kind: disabled` | Supported, emits no wake registration | Supported, emits no wake registration | Supported, emits no wake registration |

### Communication Surface

| Spawnfile feature | OpenClaw | PicoClaw | Daimon |
|-------------------|----------|----------|------------|
| `surfaces.moltnet` | Supported through generated MoltnetNode bridge and OpenClaw hooks | Supported through generated MoltnetNode bridge and Pico channel | Supported through generated MoltnetNode bridge and Daimon control endpoint |
| Moltnet wake policy `all` / `mentions` / `thread_only` / `never` | Supported by the generated bridge config | Supported by the generated bridge config | Supported by the generated bridge config |
| Discord | Supported: pairing, open, user/guild/channel allowlists with the documented one-guild channel rule | Partial: open and user allowlists; pairing and guild/channel allowlists rejected | Rejected |
| Telegram | Supported: pairing, open, user/chat allowlists | Partial: open and user allowlists; pairing and chat allowlists rejected | Rejected |
| WhatsApp | Supported: pairing, open, user/group allowlists | Partial: open and user allowlists; pairing and group allowlists rejected | Rejected |
| Slack | Supported: pairing, open, user/channel allowlists | Partial: open and user allowlists; pairing and channel allowlists rejected | Rejected |
| Webhook | Parsed by the manifest schema, but not lowered by active adapters in v0.1 | Parsed by the manifest schema, but not lowered by active adapters in v0.1 | Rejected |

### Operational Surface

| Spawnfile feature | OpenClaw | PicoClaw | Daimon |
|-------------------|----------|----------|------------|
| `spawnfile compile` | Supported | Supported | Supported |
| `spawnfile build` / `run` / `up` | Supported with pinned npm install | Supported with pinned GitHub release archive | Supported with pinned Daimon/Pi npm packages and generated app |
| `spawnfile status --live` runtime probes | Supported through OpenClaw status probes | Supported through PicoClaw status probes | Limited: deployment state and logs work; runtime health probes are not implemented yet |
| Runtime activity stream | Not normalized yet; use status/logs | Not normalized yet; use status/logs | Supported through `spawnfile.activity.v1` buffer and SSE endpoint |
| `spawnfile dev apply --agent` hot-add | Not supported in v0.1 | Not supported in v0.1 | Supported for Daimon app agents and their Moltnet bridge |
| Managed Moltnet servers and durable Moltnet state | Compiler-owned and runtime-independent | Compiler-owned and runtime-independent | Compiler-owned and runtime-independent |
