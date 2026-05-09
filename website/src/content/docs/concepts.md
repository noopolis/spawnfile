---
title: Core Concepts
description: The key ideas behind Spawnfile.
---

## Source Project

A Spawnfile source project is a directory containing a `Spawnfile` manifest and markdown docs. It's the canonical definition of your agent -- you own it, version it, and compile it.

```
my-agent/
|-- Spawnfile          # manifest
|-- SOUL.md            # personality
|-- IDENTITY.md        # self-description
|-- AGENTS.md          # instructions
|-- MEMORY.md          # memory architecture
|-- HEARTBEAT.md       # periodic tasks
\-- skills/
    \-- web_search/
        \-- SKILL.md
```

## Manifest

The `Spawnfile` is a YAML file named exactly `Spawnfile` (no extension). It declares:

- **kind** -- `agent` or `team`
- **name** -- the agent's identifier
- **runtime** -- which runtime to compile for
- **docs** -- references to markdown identity documents
- **skills** -- skill directories with `SKILL.md`
- **mcp_servers** -- MCP tool connections
- **execution** -- model, workspace, and sandbox intent
- **surfaces** -- agent-level communication channels (Discord, Telegram, WhatsApp, Slack, Moltnet, Webhook)

## Document Roles

Spawnfile defines portable document roles. Each is a markdown file the agent can read:

| Role | File | Purpose |
|------|------|---------|
| `identity` | IDENTITY.md | Who the agent is |
| `soul` | SOUL.md | Personality, voice, tone |
| `system` | AGENTS.md | Operating instructions |
| `memory` | MEMORY.md | Memory architecture |
| `heartbeat` | HEARTBEAT.md | Periodic task instructions |

All are optional. Adapters decide how to lower them into runtime-native surfaces.

## Runtime

A runtime is the host system that runs the agent. Each runtime has its own config format and workspace layout. The compiler translates your canonical source into the format each runtime expects.

Spawnfile targets **autonomous agent runtimes** -- long-lived services with markdown workspace identity. Not coding assistants or one-shot tools.

## Compilation

`spawnfile compile` reads the manifest, resolves the graph, and emits runtime-native output:

1. Parse the `Spawnfile`
2. Validate schema and file references
3. Walk the manifest graph (subagents, team members)
4. Resolve effective runtime and execution config
5. Invoke the runtime adapter
6. Resolve team context artifacts and team networks
7. Emit config files, workspace docs, container artifacts, and a compile report

The compiler operates on resolved data, not raw YAML. Adapters receive fully resolved nodes.

## Teams

A team is an organizational structure of independent agents. It defines:

- **members** -- agents that belong together
- **mode/lead/external** -- hierarchy, lead slot, and representative interface
- **shared** -- skills, MCP servers, env, and secrets inherited by all members
- **networks** -- provider-backed team communication topology

Each member agent declares its own runtime. One team can span multiple runtimes. Team coordination happens through shared declared agent surfaces and declared `team.networks[]`, not a Spawnfile-owned router.

## Surfaces

Agent manifests may declare external communication surfaces under `surfaces`. Spawnfile v0.1 alpha standardizes Discord, Telegram, WhatsApp, Slack, Moltnet, and Webhook. Portable HTTP ingress is not part of this alpha surface schema.

```yaml
surfaces:
  discord:
    access:
      users:
        - "987654321098765432"
    bot_token_secret: DISCORD_BOT_TOKEN
  telegram:
    access:
      users:
        - "123456789"
    bot_token_secret: TELEGRAM_BOT_TOKEN
  whatsapp:
    access:
      users:
        - "15551234567"
  slack:
    access:
      users:
        - "U1234567890"
    bot_token_secret: SLACK_BOT_TOKEN
    app_token_secret: SLACK_APP_TOKEN
```

Chat surfaces follow the same access-mode pattern (`pairing`, `allowlist`, `open`) but with platform-specific identifier types. Optional `identity` fields advertise an agent's own account in generated rosters. WhatsApp does not have a portable token secret -- QR/session auth is runtime-defined. Slack requires both a bot token and an app-level socket token.

Surfaces are validated at compile time against runtime support. Runtime coverage varies -- see the runtime pages for details on which access modes each runtime supports for each surface.

Team manifests do not declare surfaces. Surfaces belong to concrete agent manifests. Team manifests declare `networks` when they own shared topology such as Moltnet rooms.

## Auth Profiles

Model and surface auth is managed through local auth profiles. The `spawnfile auth` commands import credentials into a named profile, and `spawnfile run` injects them at container startup:

```bash
spawnfile auth sync --profile dev --env-file .env
spawnfile run --tag my-agent --auth-profile dev
```

Auth profiles keep secrets out of the build. `spawnfile build` is always secrets-free -- credentials are applied at run time only.

## Policy

The `policy` block controls how strictly the compiler enforces capability preservation:

```yaml
policy:
  mode: strict     # strict | warn | permissive
  on_degrade: error  # error | warn | allow
```

The compiler reports each capability as `supported`, `degraded`, or `unsupported`. Policy determines whether degradation fails the build.

When omitted, the compiler defaults to warnings -- compilation continues, but degraded or unsupported outcomes are surfaced in the report.

## Compile Report

Every compile emits `spawnfile-report.json` -- a machine-readable report showing what was preserved for each capability:

```json
{
  "nodes": [
    {
      "id": "agent:analyst",
      "runtime": "openclaw",
      "capabilities": [
        { "key": "docs.soul", "outcome": "supported" },
        { "key": "mcp.web_search", "outcome": "degraded" }
      ]
    }
  ]
}
```
