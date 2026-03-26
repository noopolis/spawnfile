---
title: TinyClaw
description: TinyClaw runtime adapter details -- native team support, per-agent config, workspace layout, and what the adapter emits.
---

TinyClaw is an active Spawnfile runtime and the strongest native team target among the supported runtimes. It is a multi-agent, multi-team runtime where settings contain both agents and teams, and each agent gets its own working directory.

**Status:** Active

## Config Shape

TinyClaw stores settings that include both agent definitions and team definitions. Each agent has its own configuration including provider, model, and working directory.

```yaml
runtime: tinyclaw
```

TinyClaw does not currently use a complex options structure in the Spawnfile. The adapter maps execution intent directly to TinyClaw's native per-agent settings.

## Workspace Layout

Each agent in TinyClaw gets its own working directory. The adapter places docs into the agent's directory and handles skill placement:

| Spawnfile Role | TinyClaw Location |
|---------------|-------------------|
| `identity` | Agent working directory |
| `soul` | Agent working directory |
| `system` | Agent working directory |
| `memory` | Agent working directory |
| `heartbeat` | Agent working directory |

Skills are copied into `.agents/skills` and then mirrored into `.claude/skills` by the runtime.

## Model Mapping

TinyClaw supports per-agent provider and model settings as well as global provider/model switching. The adapter maps:

- `execution.model.primary.provider` to the agent's provider setting
- `execution.model.primary.name` to the agent's model setting

Channel auth is channel-specific and handled separately from model configuration.

## MCP Handling

TinyClaw does not have a clear first-class MCP authoring or config surface. MCP declarations in Spawnfile manifests targeting TinyClaw will be reported as `degraded` or `unsupported` depending on the policy settings.

This is an area under ongoing research. See the runtime notes for updates.

## Workspace and Sandbox

Each agent has:
- Its own working directory
- Separate config and history
- Explicit workspace layout

The adapter maps `execution.workspace.isolation` cleanly since each TinyClaw agent already has its own isolated workspace.

## Native Team Support

TinyClaw is the strongest native team target in the Spawnfile ecosystem. Its native team shape includes:

- `id` -- team identifier
- `name` -- team display name
- `agents` -- list of member agents
- `leader_agent` -- the designated team leader

Native team interaction:
- `@team_id` messages route to the leader
- Agents mention teammates to collaborate
- Fan-out exists in the prompt protocol

### How Spawnfile Teams Map to TinyClaw

The adapter maps Spawnfile team concepts directly:

| Spawnfile Concept | TinyClaw Native |
|------------------|----------------|
| `structure.leader` | `leader_agent` |
| `members[*].id` | Agent entries in the team |
| `structure.external` | Organizational intent (recorded) |

One TinyClaw runtime process can host all compiled agents plus the compiled team object.

Nested teams likely need flattening or degradation reporting, as TinyClaw's team model is flat.

## Discord Surface

TinyClaw supports Discord as a paired DM surface. Spawnfile lowers Discord into TinyClaw's channel client config and starts the Discord worker process in the generated container.

Supported access modes:

| Mode | Support |
|------|---------|
| `pairing` | Supported |
| `allowlist` | Not supported |
| `open` | Not supported |

The upstream runtime behavior is pairing-based and DM-oriented. Spawnfile rejects richer Discord access shapes for TinyClaw at compile time.

## What The Adapter Emits

For a single agent:
- TinyClaw agent settings
- Workspace files in the agent's working directory
- Skill directories

For a team:
- Native team object with agent list and leader
- Per-agent settings and workspace files
- Compiled team configuration

For container compilation:
- Base image metadata
- Settings and workspace pre-placed into final container paths
- Start command
- Port configuration (API on port 3777)

## Container Notes

- TinyClaw is the strongest native team target: one runtime process hosts compiled agents plus the team object.
- Host-side verification uses `GET /api/agents` on port 3777.
- Compiled output pre-places runtime settings and workspace into final container paths. The entrypoint only needs minimal validation and startup.

## Example

From the `multi-runtime-team` fixture, the writer agent targets TinyClaw:

```yaml
spawnfile_version: "0.1"
kind: agent
name: writer

runtime: tinyclaw

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
  soul: SOUL.md
```

And the team manifest that includes this agent:

```yaml
spawnfile_version: "0.1"
kind: team
name: research-cell

members:
  - id: orchestrator
    ref: ./agents/orchestrator    # openclaw
  - id: researcher
    ref: ./agents/researcher      # picoclaw
  - id: writer
    ref: ./agents/writer          # tinyclaw

structure:
  mode: hierarchical
  leader: orchestrator
```

In this multi-runtime team, TinyClaw compiles the writer agent while OpenClaw and PicoClaw handle the other members. The team-level structure is preserved in the compile report.
