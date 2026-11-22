---
title: Runtimes Overview
description: What runtimes are, compatibility requirements, the runtime registry in runtimes.yaml, and how blueprints work.
---

Spawnfile compiles agent manifests to **runtime-specific output**. A runtime is an external system that hosts agents as long-lived services. The compiler uses runtime adapters to translate portable Spawnfile declarations into the configuration and workspace files each runtime expects.

## What Makes A Runtime Compatible

An adapter translates a resolved agent into the harness's native files and tells the container how to start it. A gateway, a server or a harness with a command-line interface can participate when its adapter supplies those pieces. A project can load additional adapters from local modules or installed packages. [Adding a runtime](/contributing/adding-a-runtime/)

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

1. **[OpenClaw](/runtimes/openclaw/)** -- JSON config, rich workspace layout, native `mcp.servers`, native multi-agent sessions.
2. **[PicoClaw](/runtimes/picoclaw/)** -- JSON config, workspace-first model, first-class MCP surface, spawned subagents.
3. **[Daimon](/runtimes/daimon/)** -- one pinned organization host, separate agent workspaces, and Codex, Grok or Antigravity subscriptions.
4. **[Hermes Agent](/runtimes/hermes-agent/)** supports ChatGPT, SuperGrok, Nous Portal and MiniMax logins. Its adapter lowers cron schedules, MCP servers, and supported Telegram, Discord and Slack access rules. [Hermes Agent](https://github.com/NousResearch/hermes-agent)
5. **[OpenCode](/runtimes/opencode/)** supports ChatGPT, SuperGrok and GitHub Copilot logins, plus the OpenCode Go plan key. Its adapter supports MCP servers and text-only helpers. [OpenCode](https://github.com/anomalyco/opencode)

Both harnesses export a portable `.eval` from training and use ACP for Moltnet rooms and direct messages. The bundled Moltnet v0.1.22 release predates ACP. Standalone agents and training work independently of Moltnet. [Subscription setup and feature details](https://github.com/noopolis/spawnfile/blob/main/specs/RUNTIMES.md#use-a-model-subscription)

## Exploratory Runtimes

These runtimes are tracked as adapter research targets but have no bundled adapter yet:

OpenFang provides declarative configuration and agent templates. Its Spawnfile adapter is exploratory. [OpenFang](https://github.com/RightNow-AI/openfang)

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

### Registry Contract

`runtimes.yaml` is the source of truth for supported versions and install
strategies. The `spawnfile compile` command does not require runtime source
checkouts.

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

For Hermes Agent and OpenCode, see their linked guides above. The following tables cover OpenClaw, PicoClaw and Daimon.

### Core Manifest Surface

| Spawnfile feature | OpenClaw | PicoClaw | Daimon |
|-------------------|----------|----------|------------|
| Adapter shape | One gateway target per agent | One gateway target per agent | One public Daimon organization host target for all Daimon agents (maximum 32) |
| `workspace.docs` | Supported as role files under the runtime workspace | Supported as role files under the runtime workspace | Supported per concrete agent workspace, plus a harness-owned operating contract |
| `workspace.skills` | Supported under `workspace/skills` | Supported under `workspace/skills` | Supported per concrete agent workspace |
| `workspace.resources` `volume` | Compiler-owned symlink/backing directory | Compiler-owned symlink/backing directory | Compiler-owned symlink/backing directory per concrete agent workspace |
| `workspace.resources` `git` | Compiler-owned clone/link at container startup | Compiler-owned clone/link at container startup | Compiler-owned clone/link at container startup |
| `environment.env`, `environment.secrets`, `environment.packages` | Compiler-owned container/startup behavior | Compiler-owned container/startup behavior | Compiler-owned container/startup behavior |
| `environment.mcp_servers` | Supported through OpenClaw `mcp.servers` config | Supported through PicoClaw MCP config | Supported for explicit nonempty tool allowlists; stdio commands must be absolute and remote bearer secrets remain env-name references |
| `memory` | Supported for file-backed banks through compiler-generated Mneme MCP servers in awake mode | Supported for file-backed banks through compiler-generated Mneme MCP servers in awake mode | Direct Mneme tools on one durable file-backed bank per agent |
| `execution.sandbox.mode` | Supported through OpenClaw runtime/container workspace behavior | Supported through `restrict_to_workspace` and container workspace behavior | Degraded; the generic runtime image and physical roots provide isolation |
| `subagents` | Degraded; routed sessions do not preserve full parent-owned semantics | Supported through PicoClaw subagent behavior | Degraded; the public host runs listed agents independently |

### Model, Schedule, And Surface Support

| Spawnfile feature | OpenClaw | PicoClaw | Daimon |
|-------------------|----------|----------|------------|
| OpenAI `api_key` / `codex` auth | Supported | Supported | Only optional OpenAI Codex subscription intent; auth stays Daimon-owned |
| Anthropic `api_key` auth | Supported | Supported | Rejected |
| Anthropic `claude-code` auth | Supported | Supported | Rejected |
| `custom` or `local` endpoint | Supported except subscription-import auth | Supported for compatible endpoint/auth pairs | Rejected |
| `schedule.kind: cron` | Degraded | Supported through `workspace/cron/jobs.json` | Supported through the durable native v2 scheduler |
| `schedule.kind: every` | Degraded | Degraded | Supported through the durable native v2 scheduler |
| `schedule.kind: disabled` | Supported, emits no wake registration | Supported, emits no wake registration | Supported, emits no wake registration |
| `surfaces.moltnet` | Supported through generated MoltnetNode bridge | Supported through generated MoltnetNode bridge | Supported for inbound authenticated wakes and an outbound cognition tool constrained to compiled networks, rooms, and DM policy; sends carry deterministic delivery ids and durable per-agent receipts |
| Discord, Telegram, WhatsApp, Slack | Supported with OpenClaw access-mode coverage | Partial: open and user allowlists; pairing and richer allowlists rejected | Rejected |
| Webhook | Parsed, not lowered by active adapters in v0.1 | Parsed, not lowered by active adapters in v0.1 | Rejected |

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
| `spawnfile build` / `run` / `up` | Pinned OpenClaw image | Pinned PicoClaw image | Pinned Daimon organization runtime image |
| `spawnfile status --live` runtime probes | Supported through OpenClaw status probes | Supported through PicoClaw status probes | Limited: deployment state and logs work; runtime health probes are not implemented yet |
| Runtime activity stream | Not normalized yet; use status/logs | Not normalized yet; use status/logs | Supported through `spawnfile.activity.v1` buffer and SSE endpoint |
| Managed Moltnet servers and durable Moltnet state | Compiler-owned and runtime-independent | Compiler-owned and runtime-independent | Compiler-owned and runtime-independent |
