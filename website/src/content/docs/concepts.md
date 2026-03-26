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
- **surfaces** -- external communication channels (e.g. Discord)

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
6. Emit config files, workspace docs, and a compile report

The compiler operates on resolved data, not raw YAML. Adapters receive fully resolved nodes.

## Teams

A team is an organizational structure of independent agents. It defines:

- **members** -- agents that belong together
- **structure** -- hierarchical (with a leader) or swarm (all peers)
- **shared** -- skills, MCP servers, env, and secrets inherited by all members

Each member agent declares its own runtime. One team can span multiple runtimes.

## Surfaces

Agent manifests may declare external communication surfaces under `surfaces`. The first standardized surface in v0.1 is Discord:

```yaml
surfaces:
  discord:
    access:
      users:
        - "987654321098765432"
    bot_token_secret: DISCORD_BOT_TOKEN
```

Surfaces are validated at compile time against runtime support. Runtime coverage varies -- see the runtime pages for details on which Discord access modes each runtime supports.

Team manifests do not declare surfaces. Surfaces belong to concrete agent manifests.

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

When omitted, the compiler defaults to permissive -- compilation always succeeds, but outcomes are still recorded in the report.

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
