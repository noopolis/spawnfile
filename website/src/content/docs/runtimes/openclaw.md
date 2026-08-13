---
title: OpenClaw
description: OpenClaw runtime adapter details -- config shape, workspace layout, model format, MCP handling, and what the adapter emits.
---

OpenClaw is an active Spawnfile runtime with a JSON config file and a rich markdown workspace layout. It supports multi-agent operation through native sessions, but Spawnfile v0.1 does not inject its own team router.

**Status:** Active

## Config Shape

OpenClaw uses a JSON configuration file at `~/.openclaw/openclaw.json`. The adapter emits a config file that maps Spawnfile execution intent to OpenClaw's native structure.

Key config areas:
- Agent model selection (`agent.model`)
- Auth profile configuration
- Session state and model persistence

The short-form `runtime: openclaw` in a Spawnfile normalizes internally to:

```yaml
runtime:
  name: openclaw
  options: {}
```

The long form allows adapter-specific options:

```yaml
runtime:
  name: openclaw
  options:
    profile: default
```

## Workspace Layout

OpenClaw uses `~/.openclaw/workspace` as its workspace root. The adapter places Spawnfile docs into this structure:

| Spawnfile Role | OpenClaw File |
|---------------|---------------|
| `identity` | `IDENTITY.md` |
| `soul` | `SOUL.md` |
| `system` | `AGENTS.md` |
| `memory` | `MEMORY.md` |
| `heartbeat` | `HEARTBEAT.md` |
| `extras.*` | Placed by key name (e.g. `USER.md`) |

Skills are placed under `~/.openclaw/workspace/skills/<skill>/SKILL.md`, matching the workspace skill model.

## Model Mapping

The adapter maps `execution.model.primary` to the agent's default model setting:

```yaml
# Spawnfile
execution:
  model:
    primary:
      provider: anthropic
      name: claude-sonnet-4-5
```

Fallback models are mapped only if the runtime path supports them. Auth handling remains runtime-native and adapter-specific.

## MCP Handling

OpenClaw supports MCP through native top-level `mcp.servers` config. The
adapter compiles logical Spawnfile MCP declarations into that registry, using
`transport: "stdio"` for command servers, `transport: "sse"` for SSE URLs, and
`transport: "streamable-http"` for Spawnfile `streamable_http` servers.

## Memory Handling

OpenClaw supports file-backed Spawnfile memory banks through compiler-generated
Mneme MCP servers. A durable sqlite/json memory bank emits a persistent
container mount for its store directory, installs the `mneme` CLI in the
generated image, and adds a `mneme-<memory-id>` stdio server under
`mcp.servers` with `--mode awake`; if an agent sees two banks with the same id,
Spawnfile appends a compiler-owned discriminator to keep the names distinct. If
the bank declares scheduled consolidation, Spawnfile also emits a matching
`-dream` server with `--mode dream` and pre-seeds OpenClaw's native cron store
with an isolated memory-maintenance wake. Postgres and pure in-memory stores
are reported in the compile report but do not receive generated Mneme MCP
wiring in v0.1.

## Workspace and Sandbox

- The main session can run on the host
- Non-main sessions can be sandboxed in Docker
- Workspace root is explicit and configurable

The adapter maps `workspace.docs`, `workspace.resources`, and `execution.sandbox.mode` to OpenClaw's workspace and session sandboxing configuration.

## Teams

OpenClaw does not have a native team manifest. What it has:
- Multi-agent sessions
- Agent-to-agent session tools

The adapter lowers Spawnfile team members into runtime-native agents/sessions where possible and reports degradation when native semantics do not preserve Spawnfile representatives, context artifacts, or team networks.

Nested teams and full native team identity are reported as `degraded`.

## Surfaces

OpenClaw has the strongest chat-surface support among the active runtimes. Discord, Telegram, WhatsApp, and Slack are supported with pairing, allowlist, and open access modes. Portable HTTP is not part of the v0.1 alpha surface contract.

### Discord

Spawnfile lowers Discord access into OpenClaw's rich config surface:

- `dmPolicy`
- `groupPolicy`
- `allowFrom`
- `guilds`
- `guilds.*.channels`

| Mode | Support |
|------|---------|
| `pairing` | Supported |
| `allowlist` | Supported (users, guilds, channels) |
| `open` | Supported |

Channel allowlists currently require exactly one guild in the Spawnfile lowering.

### Telegram

Spawnfile lowers Telegram access into the same rich OpenClaw channel surface:

- `dmPolicy`
- `groupPolicy`
- `allowFrom`
- `groups`

| Mode | Support |
|------|---------|
| `pairing` | Supported |
| `allowlist` | Supported (users, chats) |
| `open` | Supported |

### WhatsApp

Spawnfile lowers WhatsApp access into OpenClaw's channel surface:

- `dmPolicy`
- `groupPolicy`
- `allowFrom`
- `groups`

| Mode | Support |
|------|---------|
| `pairing` | Supported |
| `allowlist` | Supported (users, groups) |
| `open` | Supported |

WhatsApp does not have a portable token secret. QR/session auth is runtime-defined.

### Slack

Spawnfile lowers Slack access into OpenClaw's channel surface using socket mode:

- `mode: socket`
- `dmPolicy`
- `groupPolicy`
- `allowFrom`
- `channels`

| Mode | Support |
|------|---------|
| `pairing` | Supported |
| `allowlist` | Supported (users, channels) |
| `open` | Supported |

Slack requires both `bot_token_secret` and `app_token_secret`.

## What The Adapter Emits

For a single agent, the adapter emits:
- An OpenClaw JSON config file
- Workspace markdown files mapped from Spawnfile doc roles
- Skill directories with `SKILL.md` files
- MCP bridge configuration

For container compilation, the adapter provides container metadata including:
- The standalone base image
- A copy from the pinned OpenClaw runtime artifact image
- System dependencies
- Config and workspace paths inside the container
- The start command
- Port and environment configuration

OpenClaw uses `noopolis/spawnfile-runtime-openclaw:2026.6.11` by default.
Generated Dockerfiles copy `/opt/spawnfile/runtime-installs/openclaw` from
that image. To test a local runtime artifact instead:

```bash
SPAWNFILE_OPENCLAW_RUNTIME_IMAGE=noopolis/spawnfile-runtime-openclaw:2026.6.11-local \
  spawnfile build ./agentic-org
```

## Container Notes

- Container output has been verified from the host, not only inside Docker.
- The generated runtime must bind to a host-reachable gateway setting for Docker port publishing to work.
- Compiled output places config and workspace files into final runtime paths at build time. The entrypoint only needs validation and startup.
- Host-side smoke checks use the control UI root path and `/healthz`.

## Example

From the `single-agent` fixture:

```yaml
spawnfile_version: "0.1"
kind: agent
name: analyst

runtime: openclaw

execution:
  model:
    primary:
      provider: anthropic
      name: claude-sonnet-4-5
  sandbox:
    mode: workspace

workspace:
  docs:
    identity: IDENTITY.md
    soul: SOUL.md
    system: AGENTS.md
    memory: MEMORY.md
    heartbeat: HEARTBEAT.md
  skills:
    - ref: ./skills/web_search
      requires:
        mcp:
          - web_search

environment:
  mcp_servers:
    - name: web_search
      transport: streamable_http
      url: https://search.mcp.example.com/mcp
      auth:
        secret: SEARCH_API_KEY
```
