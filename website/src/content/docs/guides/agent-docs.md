---
title: Agent Docs
description: How document roles work in Spawnfile -- identity, soul, system, memory, heartbeat, and extras -- and what to put in each file.
---

Spawnfile agents are built around a **markdown workspace**: a set of Markdown documents that define who the agent is, how it behaves, and what context it operates with. The `docs` block in a Spawnfile manifest maps these documents to portable roles that compilers translate into runtime-specific surfaces.

## Document Roles

The spec defines six document roles. All are optional.

| Role | Purpose | Typical Filename |
|------|---------|-----------------|
| `identity` | Stable self-description and agent identity | `IDENTITY.md` |
| `soul` | Personality, voice, tone, and behavioral posture | `SOUL.md` |
| `system` | Operating instructions and conventions | `AGENTS.md` |
| `memory` | Human-authored memory architecture or memory intent | `MEMORY.md` |
| `heartbeat` | Human-authored recurring or periodic task intent | `HEARTBEAT.md` |
| `extras` | Arbitrary additional documents keyed by author-defined names | varies |

### Declaring Docs

```yaml
docs:
  identity: IDENTITY.md
  soul: SOUL.md
  system: AGENTS.md
  memory: MEMORY.md
  heartbeat: HEARTBEAT.md
  extras:
    user: USER.md
    notes: docs/NOTES.md
```

Paths are relative to the manifest directory and must point to UTF-8 Markdown files within the project root. Forward slashes are required regardless of host OS.

## What Goes In Each File

### identity

The identity document is the agent's stable self-description. It answers "who am I?" in a way that persists across sessions and tasks.

Example from the `single-agent` fixture:

```markdown
# Analyst

You are a research analyst focused on fast, source-backed synthesis.
```

Use this for the agent's name, role, and core purpose. Keep it factual and concise. This is not the place for behavioral instructions -- that belongs in `soul` or `system`.

### soul

The soul document defines personality, voice, and behavioral posture. It shapes how the agent communicates rather than what it does.

Example:

```markdown
# Voice

Be concise, skeptical, and explicit about uncertainty.
```

This is where you set tone, communication style, values, and constraints on how the agent expresses itself. Runtimes that support separate personality or voice surfaces will map this document there.

### system

The system document contains operating instructions -- the practical conventions and workflows the agent should follow.

Example:

```markdown
# Operating Instructions

Start with the user's objective, gather only necessary context,
and return a short answer with sources when available.
```

This is the most common doc role. Many simple agents only need a `system` doc. It maps to surfaces like `AGENTS.md` in OpenClaw and PicoClaw.

### memory

The memory document declares human-authored memory architecture or intent. It tells the agent what to remember and how to organize its working memory.

Example:

```markdown
# Memory Intent

Keep lightweight working memory about recent goals and evidence
gathered during a task.
```

This is not runtime-managed memory storage -- it is author-written guidance about what the agent should track. Runtimes with memory engines may use this as seed content or initialization instructions.

### heartbeat

The heartbeat document declares recurring or periodic task intent. It tells the agent what to check or do on an ongoing basis.

Example:

```markdown
# Heartbeat Intent

Periodically review whether the current line of work is still
aligned with the user's request.
```

Runtimes with heartbeat or cron-like systems can use this to configure periodic behavior. The exact mechanism is runtime-dependent.

### extras

The `extras` map lets you attach arbitrary additional documents under author-defined keys.

```yaml
docs:
  extras:
    user: USER.md
    notes: docs/NOTES.md
```

Use extras for project-specific context, reference material, or any document that does not fit the built-in roles.

## How Runtimes Use Docs

The compiler treats document contents as opaque text. It does not interpret or rewrite them. Instead, each runtime adapter maps document roles to the runtime's native workspace surfaces.

For example:
- OpenClaw has workspace files like `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `HEARTBEAT.md`, and `MEMORY.md` that map directly to Spawnfile roles.
- PicoClaw uses a similar workspace layout with `AGENTS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `SOUL.md`, and a `memory/` directory.
- TinyClaw gives each agent its own working directory where docs are placed.

If a runtime cannot use a particular document role, the compiler reports the capability as `degraded` or `unsupported` according to the project's policy settings.

## Team Docs

Teams also have a `docs` block, but team docs describe the team manifest itself -- purpose, coordination rules, decision-making norms. They do not automatically propagate to member agents.

```yaml
kind: team
name: research-cell

docs:
  system: TEAM.md
```

The team's `system` doc (typically `TEAM.md`) should reference member slot IDs explicitly so agents can identify their role. Example from the `multi-runtime-team` fixture:

```markdown
# Team Intent

The orchestrator receives work, the researcher gathers facts,
and the writer turns the result into final prose.
```

Adapters that support team context injection may make the team doc available to members, but this is not guaranteed by the portable spec.

## Tips

- Start with just `system` if you are writing a simple agent. Add other roles as the agent grows.
- Keep each document focused on its role. Do not mix personality (soul) with operating instructions (system).
- Use `identity` for facts about the agent that should not change between tasks. Use `soul` for how the agent communicates.
- The `memory` and `heartbeat` roles express intent, not configuration. The runtime decides how to implement them.
- Document contents are entirely up to you. The spec does not prescribe internal structure beyond requiring UTF-8 Markdown.
