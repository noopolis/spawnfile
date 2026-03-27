---
title: PicoClaw
description: PicoClaw runtime adapter details -- config shape, workspace layout, MCP surface, model mapping, and what the adapter emits.
---

PicoClaw is an active Spawnfile runtime with a JSON config file and a workspace-first model. It has one of the strongest MCP surfaces among the supported runtimes.

**Status:** Active

## Config Shape

PicoClaw uses a JSON configuration file at `~/.picoclaw/config.json`. The adapter emits config that maps Spawnfile execution intent to PicoClaw's native structure.

```yaml
runtime:
  name: picoclaw
  options:
    restrict_to_workspace: true
```

Runtime options like `restrict_to_workspace` are adapter-specific and passed through to the compiled config.

## Workspace Layout

PicoClaw defaults to `~/.picoclaw/workspace` as its workspace root. The adapter places docs into this structure:

| Spawnfile Role | PicoClaw File |
|---------------|---------------|
| `identity` | `IDENTITY.md` |
| `soul` | `SOUL.md` |
| `system` | `AGENTS.md` |
| `memory` | `memory/` directory |
| `heartbeat` | `HEARTBEAT.md` |
| `extras.*` | Placed by key name |

Skills are placed under the workspace `skills/` directory with their `SKILL.md` files preserved. PicoClaw also supports global skills, builtin skills, and a registry/search/install system.

## Model Mapping

PicoClaw uses a model-centric config via `vendor/model` format. The adapter maps:

- `execution.model.primary` to the default vendor/model setting
- `execution.model.fallback` to PicoClaw's fallback model list (explicitly supported)

Provider-specific auth uses PicoClaw's native auth system (e.g. `picoclaw auth login --provider anthropic`).

At the pinned version, the compiled config uses `model_list[].api_key` with file references like `file://secrets/OPENAI_API_KEY`. The entrypoint materializes those files from environment variables before startup.

## MCP Handling

PicoClaw has a first-class MCP config surface, making it one of the best early targets for canonical MCP lowering:

```json
{
  "tools": {
    "mcp": {
      "enabled": true,
      "servers": {
        "web_search": {
          "enabled": true,
          "type": "http",
          "url": "https://search.mcp.example.com/mcp"
        }
      }
    }
  }
}
```

Supported transports:
- `stdio` -- via `command`, `args`, `env`
- `sse` -- via `url`
- `http` -- via `url`, `headers`

Each server can have `enabled`, `command`, `args`, `env`, `env_file`, `type`, `url`, and `headers` fields.

## Workspace and Sandbox

PicoClaw has a strong workspace-first model:

- `restrict_to_workspace` is the main sandbox switch
- The same restriction is inherited by subagents and heartbeat tasks

The adapter maps:
- `execution.workspace.isolation` to workspace path configuration
- `execution.sandbox.mode` to `restrict_to_workspace` and related settings

## Teams and Routing

PicoClaw has:
- Route bindings with `binding.team` as a routing tier
- Spawned subagents with optional `agent_id`
- Heartbeat-driven async spawning

It does not have a strong native team object. The adapter:
- Compiles team members into named agents
- Uses spawn or agent-targeted spawn for delegation
- Reports degradation for native team identity and nesting

## Surfaces

PicoClaw supports all four portable surfaces with token wiring and user allowlists. Guild, channel, chat, and group allowlists are not lowered in v0.1.

### Discord

Spawnfile lowers Discord into PicoClaw's channel config:

- `token`
- `allow_from`
- `mention_only`

| Mode | Support |
|------|---------|
| `open` | Supported |
| `allowlist` (users) | Supported |
| `allowlist` (guilds/channels) | Not lowered in v0.1 |
| `pairing` | Not supported |

### Telegram

Spawnfile lowers Telegram into PicoClaw's channel config:

- `token`
- `allow_from`

| Mode | Support |
|------|---------|
| `open` | Supported |
| `allowlist` (users) | Supported |
| `allowlist` (chats) | Not lowered in v0.1 |
| `pairing` | Not supported |

### WhatsApp

Spawnfile lowers WhatsApp into PicoClaw's channel config:

- `enabled`
- `use_native`
- `allow_from`

| Mode | Support |
|------|---------|
| `open` | Supported |
| `allowlist` (users) | Supported |
| `allowlist` (groups) | Not lowered in v0.1 |
| `pairing` | Not supported |

WhatsApp does not have a portable token secret. QR/session auth is runtime-defined.

### Slack

Spawnfile lowers Slack into PicoClaw's channel config:

- `enabled`
- `group_trigger.mention_only`
- `allow_from`

| Mode | Support |
|------|---------|
| `open` | Supported |
| `allowlist` (users) | Supported |
| `allowlist` (channels) | Not lowered in v0.1 |
| `pairing` | Not supported |

Slack requires both `bot_token_secret` and `app_token_secret`. PicoClaw replies to channel messages in a thread and replies to direct messages inline.

## What The Adapter Emits

For a single agent:
- A PicoClaw JSON config file
- Workspace markdown files
- Skill directories
- MCP server configuration

For container compilation:
- Base image metadata and system dependencies
- Config and workspace path templates
- Port configuration (health on `/health` and `/ready`)
- Start command (`picoclaw gateway --allow-empty`)

## Container Notes

- The pinned version needs `workspace/` copied into `cmd/picoclaw/internal/onboard/workspace` before `go build` in a clean checkout.
- Provider auth needs `model_list[].api_key` file references. The entrypoint materializes secret files from env before startup.
- Clean container boot uses `picoclaw gateway --allow-empty`.
- Health endpoints: `/health` and `/ready`.
- For multi-agent compilation, one PicoClaw gateway process runs per compiled target with ports incremented from the adapter base port.

## Example

From the `agent-with-subagents` fixture:

```yaml
spawnfile_version: "0.1"
kind: agent
name: editor

runtime:
  name: picoclaw
  options:
    restrict_to_workspace: true

execution:
  model:
    primary:
      provider: openai
      name: gpt-4o-mini
  workspace:
    isolation: isolated
  sandbox:
    mode: workspace

docs:
  system: AGENTS.md

subagents:
  - id: researcher
    ref: ./subagents/researcher
  - id: critic
    ref: ./subagents/critic
```
