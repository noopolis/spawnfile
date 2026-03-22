---
title: OpenClaw
description: OpenClaw runtime adapter details -- config shape, workspace layout, model format, MCP handling, and what the adapter emits.
---

OpenClaw is an active Spawnfile runtime with a JSON config file and a rich markdown workspace layout. It supports multi-agent operation through routing and isolated sessions.

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

OpenClaw supports MCP through an `mcporter` bridge layer rather than a pure first-class MCP config surface. The adapter compiles logical Spawnfile MCP declarations into OpenClaw's MCP bridge or plugin-native config.

ACPX runtime paths can inject named MCP server maps, which gives the adapter a target for MCP lowering.

## Workspace and Sandbox

- The main session can run on the host
- Non-main sessions can be sandboxed in Docker
- Workspace root is explicit and configurable

The adapter maps `execution.workspace.isolation` and `execution.sandbox.mode` to OpenClaw's workspace and session sandboxing configuration.

## Teams and Routing

OpenClaw does not have a native team manifest. What it has:
- Multi-agent routing
- Routed sessions
- Agent-to-agent session tools

The adapter lowers Spawnfile team members into routed agents and maps the team leader to the initial route target. Delegate relationships are lowered into session coordination tools like `sessions_send`.

Nested teams and full native team identity are reported as `degraded`.

## What The Adapter Emits

For a single agent, the adapter emits:
- An OpenClaw JSON config file
- Workspace markdown files mapped from Spawnfile doc roles
- Skill directories with `SKILL.md` files
- MCP bridge configuration

For container compilation, the adapter provides container metadata including:
- The standalone base image
- System dependencies
- Config and workspace paths inside the container
- The start command
- Port and environment configuration

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
  workspace:
    isolation: isolated
  sandbox:
    mode: workspace

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

mcp_servers:
  - name: web_search
    transport: streamable_http
    url: https://search.mcp.example.com/mcp
    auth:
      secret: SEARCH_API_KEY
```
