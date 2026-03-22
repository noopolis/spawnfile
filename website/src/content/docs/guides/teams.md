---
title: Teams
description: How to define team manifests with structure, members, shared surfaces, and the external field.
---

A Spawnfile team is an organizational structure that groups multiple first-class agents. It defines who is in the team, what they share, and how the team is organized.

Teams are distinct from agents with subagents:
- An **agent with subagents** is one authored agent with internal helpers. Subagent orchestration is the runtime's concern.
- A **team** is several first-class authored agents that belong together. Team coordination happens through external communication surfaces (channels, A2A, webhooks), not runtime internals.

## Team Manifest

A team manifest uses `kind: team` and must declare a `structure` block:

```yaml
spawnfile_version: "0.1"
kind: team
name: research-cell

docs:
  system: TEAM.md

shared:
  skills:
    - ref: ./shared/skills/web_search
  mcp_servers:
    - name: web_search
      transport: streamable_http
      url: https://search.mcp.example.com/mcp
      auth:
        secret: SEARCH_API_KEY
  secrets:
    - name: SEARCH_API_KEY
      required: true

members:
  - id: orchestrator
    ref: ./agents/orchestrator
  - id: researcher
    ref: ./agents/researcher
  - id: writer
    ref: ./agents/writer

structure:
  mode: hierarchical
  leader: orchestrator

policy:
  mode: warn
  on_degrade: warn
```

## Members

Each member must have a unique `id` within the team and a `ref` pointing to either an agent source project or another team source project.

```yaml
members:
  - id: orchestrator
    ref: ./agents/orchestrator
  - id: researcher
    ref: ./agents/researcher
  - id: writer
    ref: ./agents/writer
```

The `id` is the **slot name** -- the role this agent fills in this team. The `ref` is who fills that slot. The same agent project may fill different slots in different teams.

Each referenced agent declares its own `runtime` in its Spawnfile. Teams do not override or assign runtimes to members. Direct members of the same team may be on different runtimes.

### Nested Teams

A member `ref` may point to another team, creating a nested team. The nested team is a black box to the outer team:

- The outer team targets the nested team as a unit by its `member.id`.
- The outer team must not address inner members directly.
- The inner team is compiled separately.
- Inner members must not interact with outer team members through the portable spec.

If a runtime lacks nested team support, the compiler may flatten the boundary but must report `degraded`.

## Structure

The `structure` block defines the organizational topology. It is required for team manifests.

### mode

The `mode` field is required and must be one of:

| Mode | Description |
|------|-------------|
| `hierarchical` | Leader-led team. One member is the designated leader. |
| `swarm` | Flat peer team. All members are equals with no formal leader. |

### leader

The `id` of the member who leads the team. Required when `mode` is `hierarchical`. Must not be present when `mode` is `swarm`.

```yaml
structure:
  mode: hierarchical
  leader: orchestrator
```

The leader is the default authority, escalation point, and -- unless `external` overrides it -- the default voice of the team to the outside world.

### external

An optional list of member IDs that are allowed to respond to messages from outside the team. Members not listed are internal-only.

```yaml
# Only leader talks externally (hierarchical default)
structure:
  mode: hierarchical
  leader: orchestrator

# Leader and researcher both respond externally
structure:
  mode: hierarchical
  leader: orchestrator
  external: [orchestrator, researcher]

# Swarm, all respond externally (swarm default)
structure:
  mode: swarm

# Swarm, but only two respond externally
structure:
  mode: swarm
  external: [monitor-a, monitor-b]
```

Defaults:
- `hierarchical` mode: defaults to `[leader]`
- `swarm` mode: defaults to all members

The `external` field is organizational intent. Enforcement depends on the deployment surface.

## Shared Surfaces

The `shared` block declares skills, MCP servers, env values, and secrets that all direct members inherit.

```yaml
shared:
  skills:
    - ref: ./shared/skills/web_search
  mcp_servers:
    - name: web_search
      transport: streamable_http
      url: https://search.mcp.example.com/mcp
      auth:
        secret: SEARCH_API_KEY
  env:
    LOG_LEVEL: info
  secrets:
    - name: SEARCH_API_KEY
      required: true
```

Inheritance rules:
- Members extend the shared surface.
- Members cannot remove inherited items.
- On MCP name conflict, member-local wins.
- On env or secret name conflict, member-local wins.
- Shared surfaces do not propagate through nested team boundaries.

## Team Docs

The team's `docs.system` document (typically `TEAM.md`) describes the team as a collective. It is the place for:

- Handoff protocols between members
- Escalation procedures
- Decision-making norms
- Quality standards

The document should reference member slot IDs explicitly so agents can identify their role:

```markdown
# Team Intent

The orchestrator receives work, the researcher gathers facts,
and the writer turns the result into final prose.
```

Team docs stay local to the team manifest. They are not automatically propagated to member agents. Adapters that support team context injection may make the team doc available to members.

## Multi-Runtime Teams

Members of the same team may target different runtimes. From the `multi-runtime-team` fixture:

```yaml
# agents/orchestrator/Spawnfile
runtime: openclaw

# agents/researcher/Spawnfile
runtime: picoclaw

# agents/writer/Spawnfile
runtime: tinyclaw
```

When `spawnfile compile` runs on a team root, the compiler walks the member graph and compiles each agent using that member's declared runtime. For multi-runtime teams, the compiler emits multiple runtime-specific outputs as part of the same compile run.

## How Runtimes Handle Teams

Team lowering varies by runtime:

- **TinyClaw** has the strongest native team support with team ID, member list, and a `leader_agent` field. Spawnfile teams map well to TinyClaw's native team object.
- **OpenClaw** uses routed agent sessions. Team members become named agents with routing between them.
- **PicoClaw** uses spawned subagents with routing. Members become named agents that can be spawned and targeted.
- **NullClaw** and **ZeroClaw** use delegate agent patterns. Members become named delegate agents.

If a runtime cannot preserve the declared team structure, the compiler reports `degraded` or `unsupported` for the affected capabilities. The compile report always records capability outcomes for `team.members`, `team.structure.mode`, `team.structure.leader`, `team.structure.external`, `team.shared`, and `team.nested`.

## Complete Example

The `multi-runtime-team` fixture shows a full team project:

```text
multi-runtime-team/
  Spawnfile          # kind: team
  TEAM.md            # docs.system
  agents/
    orchestrator/
      Spawnfile      # runtime: openclaw
      AGENTS.md
    researcher/
      Spawnfile      # runtime: picoclaw
      SOUL.md
    writer/
      Spawnfile      # runtime: tinyclaw
      SOUL.md
  shared/
    skills/
      web_search/
        SKILL.md
```
