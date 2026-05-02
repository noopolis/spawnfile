---
title: Communication Surfaces
description: Portable communication-surface model for Spawnfile v0.1 alpha.
---

This document defines the portable communication-surface model that sits on top of the [Spawnfile Specification](/spec/spec/).

## Purpose

A **surface** is an agent-level communication capability. Concrete agent manifests declare `surfaces`; team manifests declare `networks`.

A **team network** is team-level organizational communication topology under `team.networks[]`. Moltnet is the first provider for this contract.

Spawnfile has a write-only runtime boundary. It does not read spawned runtimes to discover account IDs or update rosters from runtime state. Roster addresses are emitted only when they are derivable from the manifest or explicitly authored through `identity`.

## Current Portable Surfaces

Spawnfile v0.1 alpha standardizes:

- `discord`
- `telegram`
- `whatsapp`
- `slack`
- `moltnet`
- `webhook`

Portable HTTP ingress is not part of this alpha schema. Runtime-native HTTP APIs may exist through runtime-specific options, but they are not portable Spawnfile surfaces and do not appear in rosters.

```yaml
surfaces:
  slack:
    identity:
      user_id: "U1234567890"
    access:
      mode: allowlist
      users: ["U1234567890"]
      channels: ["C1234567890"]
    bot_token_secret: SLACK_BOT_TOKEN
    app_token_secret: SLACK_APP_TOKEN
  moltnet:
    - network: local_lab
      rooms:
        research:
          read: all
          reply: auto
      dms:
        enabled: true
        read: mentions
        reply: never
```

## Surface Identity

`identity` is optional opt-in roster metadata. It does not provision accounts, guarantee provider-side reachability, or allow Spawnfile to read runtime state.

| Surface | Identity fields | Roster address |
|---|---|---|
| `discord` | `user_id` | `addresses.discord.user_id` |
| `telegram` | `user_id` and/or `username` | `addresses.telegram.user_id`, `addresses.telegram.username` |
| `whatsapp` | `phone` | `addresses.whatsapp.phone` |
| `slack` | `user_id` | `addresses.slack.user_id` |
| `moltnet` | derived from team network attachment | `addresses.moltnet.<network_id>.fqid` |

If a chat surface is declared without `identity`, rosters may list that surface while omitting an address. Teammates then rely on native discovery: mentions, channel membership, replies, or provider UI.

## Access Rules

- Discord access uses `pairing`, `allowlist`, or `open`.
- Telegram access uses `pairing`, `allowlist`, or `open`.
- WhatsApp access uses `pairing`, `allowlist`, or `open`.
- Slack access uses `pairing`, `allowlist`, or `open`.
- If an access mode is omitted and allowlist entries are present, the effective mode is `allowlist`.
- If an access block is omitted entirely, behavior is runtime-defined and is not portable.
- Surface secrets are runtime env references, not inline manifest secrets.
- WhatsApp does not currently have a portable token-secret field; QR/session auth remains runtime-defined.

## Moltnet

Moltnet is both an agent surface and the first `team.networks[]` provider.

```yaml
networks:
  - id: local_lab
    provider: moltnet
    rooms:
      - id: research
        members: [lead, writer]
```

Rules:

- Agent attachments reference team-declared networks and rooms.
- `read` may be `all`, `mentions`, or `thread_only`.
- `reply` may be only `auto` or `never` in this alpha. `manual` is not portable.
- Moltnet FQIDs are derivable and emitted into context-scoped rosters.
- Parent room child-team members expand through the child team's representative chain.
- Non-representative child members do not receive parent room attachments.
- Moltnet member IDs are direct agent member slot IDs and must be unique across the reachable nested team graph.
- Compatible duplicate attachments for the same `(network_id, member_id)` merge rooms; incompatible duplicates fail compilation.

## Runtime Support Matrix

| Surface | OpenClaw | PicoClaw | TinyClaw |
|---|---|---|---|
| Discord | pairing, allowlist, open | open, allowlist | pairing |
| Telegram | pairing, allowlist, open | open, allowlist | pairing |
| WhatsApp | pairing, allowlist, open | open, allowlist | pairing |
| Slack | pairing, allowlist, open | open, allowlist | unsupported |
| Moltnet | team-network attachments | team-network attachments | constrained by scope limits |
| Webhook | not yet | not yet | not yet |

## Runtime Verification

The Moltnet team-network contract requires an opt-in, release-gating E2E that compiles, builds, runs, and verifies a real team conversation through Moltnet room history. Slack, Discord, Telegram, and WhatsApp do not need equivalent team-chat E2Es for this contract because Spawnfile only carries their declared identity/roster data.
