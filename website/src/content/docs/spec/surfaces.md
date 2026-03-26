---
title: Communication Surfaces
description: Portable communication-surface model for Spawnfile v0.1 -- Discord surface schema, access rules, and runtime support matrix.
---

This document defines the portable communication-surface model that sits on top of `SPEC.md`.

`SPEC.md` remains the canonical source schema. This file exists to make three things explicit:

- what a surface is
- what the standardized Discord surface means in v0.1
- which runtimes support which Discord access shapes

---

## Purpose

A **surface** is an external interaction boundary through which humans or systems can reach an agent.

This is intentionally broader than "chat channel". In v0.1, the first standardized surface is Discord, but the abstraction is meant to grow to cover other messaging systems, webhook/http ingress, and future agent-network or room integrations.

Surfaces are:

- declared on agent manifests
- validated at compile time against runtime support
- provisioned through the same auth/run path as model credentials

Team manifests do not declare surfaces in v0.1. Surfaces belong to concrete agents.

---

## Current Portable Surface

Spawnfile v0.1 standardizes one initial surface:

```yaml
surfaces:
  discord:
    access:
      mode: allowlist
      users:
        - "987654321098765432"
      guilds:
        - "123456789012345678"
      channels:
        - "555555555555555555"
    bot_token_secret: DISCORD_BOT_TOKEN
```

### Fields

| Field | Meaning |
|------|---------|
| `bot_token_secret` | Env var name carrying the Discord bot token. Defaults to `DISCORD_BOT_TOKEN`. |
| `access.mode` | Access policy: `pairing`, `allowlist`, or `open`. |
| `access.users` | Allowed Discord user IDs. |
| `access.guilds` | Allowed Discord guild/server IDs. |
| `access.channels` | Allowed Discord channel IDs. |

### Access Rules

- If `access.mode` is omitted and any of `users`, `guilds`, or `channels` are present, the effective mode is `allowlist`.
- `users`, `guilds`, and `channels` are only valid with `allowlist`.
- `allowlist` must declare at least one of `users`, `guilds`, or `channels`.
- Surface secrets are runtime env, not inline manifest secrets.

### ID Sources

For Discord, the identifiers are copied from Discord Developer Mode:

- user ID
- guild/server ID
- channel ID

These are low-level identifiers, but they are stable and map cleanly to allowlist semantics.

---

## Runtime Support Matrix

The portable schema is broader than any single runtime. A conforming compiler must validate the declared surface against the selected runtime and fail early when the runtime cannot preserve it.

### Discord

| Runtime | Supported Access | Notes |
|--------|------------------|-------|
| `openclaw` | `pairing`, `allowlist`, `open` | Supports user, guild, and channel policy lowering. Channel allowlists currently require exactly one guild in Spawnfile lowering. |
| `picoclaw` | `open`, `allowlist` | Supports Discord token wiring and user allowlists. Guild/channel allowlists are not lowered in v0.1. |
| `tinyclaw` | `pairing` | Discord client is DM-oriented and pairing-gated. Declarative user/guild/channel allowlists are not supported in Spawnfile v0.1. |

### Practical Meaning

- `openclaw` is the best current target for full Discord channel/server policy.
- `picoclaw` is a good target for token-based Discord plus simple user allowlists.
- `tinyclaw` supports Discord as a paired DM surface, not as a general guild/channel surface.

---

## Runtime Lowering Notes

### OpenClaw

Spawnfile lowers Discord access into the runtime's richer Discord config surface:

- `dmPolicy`
- `groupPolicy`
- `allowFrom`
- `guilds`
- `guilds.*.channels`

OpenClaw is the only bundled runtime where the first portable Discord surface maps to a real channel/server policy model instead of a reduced subset.

### PicoClaw

Spawnfile lowers Discord into PicoClaw's simpler channel config:

- `token`
- `allow_from`
- `mention_only`

PicoClaw's user allowlists map well. Guild/channel allowlists do not currently have a portable lowering in Spawnfile.

### TinyClaw

Spawnfile lowers Discord into TinyClaw's channel client config and starts the Discord worker process in the generated container.

But the upstream runtime behavior remains pairing-based and DM-oriented, so Spawnfile rejects richer Discord access shapes for TinyClaw at compile time.

---

## Relationship To Other Specs

- `SPEC.md`
  Defines the canonical manifest schema for `surfaces`.
- `COMPILER.md`
  Defines when surface support is resolved and validated.
- `CONTAINERS.md`
  Defines how surface secrets are emitted into `.env.example` and injected at run time.
- `RUNTIMES.md`
  Tracks which runtimes exist; this file tracks what the current standardized surface means on those runtimes.
