---
title: Teams
description: How to define team manifests with members, representatives, team networks, and context artifacts.
---

A Spawnfile team is an organizational structure that groups multiple first-class agents. It defines who is in the team, what they share, how representatives are selected, and which team networks and context artifacts the compiler emits.

Teams are distinct from agents with subagents:

- An **agent with subagents** is one authored agent with internal helpers. Subagent orchestration is the runtime's concern.
- A **team** is several first-class authored agents that belong together. Team coordination happens through shared declared agent surfaces and declared `team.networks[]`, not a Spawnfile-owned router.

Spawnfile v0.1 alpha does not inject a team-message MCP tool, a surface router, team route env vars, or team-level auth.

## Team Manifest

```yaml
spawnfile_version: "0.1"
kind: team
name: research-cell

docs:
  system: TEAM.md

mode: hierarchical
lead: orchestrator

members:
  - id: orchestrator
    ref: ./agents/orchestrator
  - id: researcher
    ref: ./agents/researcher
  - id: writer
    ref: ./agents/writer

networks:
  - id: local_lab
    provider: moltnet
    rooms:
      - id: research-room
        members: [orchestrator, researcher, writer]
```

## Members

Each member has a unique slot `id` within the team and a `ref` pointing to an agent source project or another team source project. The same agent source project may fill different slots in different teams. Each occurrence is a separate direct membership, so the compiler keeps its `TEAM.md`, roster, and team-network context separate.

Each referenced agent declares its own `runtime`. Teams do not override or assign runtimes to members.

## Nested Teams And Representatives

A member `ref` may point to another team. The nested team is a black box to the outer team. Parent-team communication crosses the boundary through selected representatives.

Representative selection:

- If `external` is declared, those direct member slots represent the team.
- Else if `mode: hierarchical`, the `lead` slot represents the team.
- Else if `mode: swarm`, all direct member slots represent the team.
- If a selected slot is itself a team, the compiler resolves that child team's representatives with the same rules.

The compiler does not include arbitrary descendants. Non-representative child members do not receive parent `TEAM.md`, parent rosters, parent team cards, or parent Moltnet room attachments.

## Mode, Lead, And External

```yaml
mode: hierarchical
lead: orchestrator
external: [orchestrator, researcher]
```

`mode` is required and must be `hierarchical` or `swarm`.

`lead` is required for hierarchical teams and must be absent for swarm teams. A lead may be a nested team; if it resolves to multiple concrete representatives, those representatives are all lead delegates. Runtime adapters must not silently pick one.

`external` is optional representative intent. It is not router intent and does not create forwarding behavior.

## Team Networks

`team.networks[]` is organizational communication topology. `surfaces` are agent-level communication capabilities. Moltnet is the current team-network provider.

```yaml
networks:
  - id: local_lab
    provider: moltnet
    rooms:
      - id: org-council
        members: [coordinator, research-team]
```

Room members may name direct agent slots or direct child-team slots. Child-team slots expand through representatives only. Moltnet member IDs are direct agent member slot IDs and must be unique across the reachable nested team graph.

Moltnet `reply` policy is `auto | never` in this alpha. `manual` is not portable.

## TEAM.md And Context Files

The team's `docs.system` document is typically `TEAM.md`. It describes the team as a collective and may include handoff protocols, escalation procedures, decision-making norms, and quality standards.

The compiler emits `TEAM.md` literally as generated team context. It does not pass it through runtime doc-role mapping and does not merge several team docs.

Direct memberships receive:

```text
.spawnfile/team-contexts/<team-context-key>/TEAM.md
.spawnfile/rosters/<team-context-key>.yaml
```

If an agent has exactly one direct team membership, it also receives root aliases:

```text
TEAM.md
.spawnfile/roster.yaml
```

Reusable agents with multiple direct memberships do not get those root aliases because the context would be ambiguous.

Selected representatives receive parent-context artifacts:

```text
.spawnfile/team-contexts.yaml
.spawnfile/team-contexts.md
.spawnfile/team-contexts/<team-context-key>/TEAM.md
.spawnfile/rosters/<team-context-key>.yaml
.spawnfile/team-cards/<team-context-key>/<parent-member-slot-id>.md
```

## Rosters

Rosters are context-scoped. Entries carry derivable per-surface `addresses`, not routed endpoints.

- Moltnet FQIDs are derivable.
- Slack, Discord, Telegram, and WhatsApp addresses require optional `surfaces.<name>.identity`.
- Portable HTTP addresses are not part of roster v2.
- No roster `auth` block exists.
- Nested team entries expose only team cards plus selected representatives.

The compiler warns when a roster has no shared declared coordination surface between visible participants, or when one participant is isolated. These are compile-report warnings, not manifest rejection rules.

## Runtime Lowering

Team lowering varies by runtime. If a runtime cannot preserve the declared team structure, representatives, context artifacts, or team networks, the compiler reports `degraded` or `unsupported`.

Capability outcomes include `team.members`, `team.mode`, `team.lead`, `team.external`, `team.shared`, `team.nested`, `team.roster`, `team.context_orientation`, `team.representatives`, `team.networks`, and provider/network-specific `team.networks.*` keys.
