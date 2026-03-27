# Communication Surfaces v0.1

This document defines the portable communication-surface model that sits on top of `SPEC.md`.

`SPEC.md` remains the canonical source schema. This file exists to make three things explicit:

- what a surface is
- what the standardized Discord, Telegram, WhatsApp, and Slack surfaces mean in v0.1
- which runtimes support which portable surface shapes

---

## Purpose

A **surface** is an external interaction boundary through which an agent exchanges messages with humans, systems, or other agents.

This is intentionally broader than "chat channel". In v0.1, the first standardized surfaces are Discord, Telegram, WhatsApp, and Slack, but the abstraction is meant to grow to cover other messaging systems, webhook/http ingress, and future agent-network or room integrations.

Surfaces are:

- declared on agent manifests
- validated at compile time against runtime support
- provisioned through the same auth/run path as model credentials

Team manifests do not declare surfaces in v0.1. Surfaces belong to concrete agents.

---

## Current Portable Surface

Spawnfile v0.1 standardizes four initial surfaces:

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
  telegram:
    access:
      mode: allowlist
      users:
        - "123456789"
      chats:
        - "-1001234567890"
    bot_token_secret: TELEGRAM_BOT_TOKEN
  whatsapp:
    access:
      mode: allowlist
      users:
        - "15551234567"
      groups:
        - "120363400000000000@g.us"
  slack:
    access:
      mode: allowlist
      users:
        - "U1234567890"
      channels:
        - "C1234567890"
    bot_token_secret: SLACK_BOT_TOKEN
    app_token_secret: SLACK_APP_TOKEN
```

### Fields

| Field | Meaning |
|------|---------|
| `discord.bot_token_secret` | Env var name carrying the Discord bot token. Defaults to `DISCORD_BOT_TOKEN`. |
| `discord.access.mode` | Access policy: `pairing`, `allowlist`, or `open`. |
| `discord.access.users` | Allowed Discord user IDs. |
| `discord.access.guilds` | Allowed Discord guild/server IDs. |
| `discord.access.channels` | Allowed Discord channel IDs. |
| `telegram.bot_token_secret` | Env var name carrying the Telegram bot token. Defaults to `TELEGRAM_BOT_TOKEN`. |
| `telegram.access.mode` | Access policy: `pairing`, `allowlist`, or `open`. |
| `telegram.access.users` | Allowed Telegram user IDs. |
| `telegram.access.chats` | Allowed Telegram chat IDs. |
| `whatsapp.access.mode` | Access policy: `pairing`, `allowlist`, or `open`. |
| `whatsapp.access.users` | Allowed WhatsApp user identifiers. |
| `whatsapp.access.groups` | Allowed WhatsApp group identifiers. |
| `slack.bot_token_secret` | Env var name carrying the Slack bot token. Defaults to `SLACK_BOT_TOKEN`. |
| `slack.app_token_secret` | Env var name carrying the Slack app-level socket token. Defaults to `SLACK_APP_TOKEN`. |
| `slack.access.mode` | Access policy: `pairing`, `allowlist`, or `open`. |
| `slack.access.users` | Allowed Slack user IDs. |
| `slack.access.channels` | Allowed Slack channel IDs. |

### Access Rules

- If `access.mode` is omitted and any of `users`, `guilds`, or `channels` are present, the effective mode is `allowlist`.
- `users`, `guilds`, and `channels` are only valid with `allowlist`.
- `allowlist` must declare at least one of `users`, `guilds`, or `channels`.
- Telegram follows the same pattern, using `users` and `chats`.
- WhatsApp follows the same pattern, using `users` and `groups`.
- Slack follows the same pattern, using `users` and `channels`.
- If `access` is omitted entirely, the effective behavior is runtime-defined and is not currently portable. Projects that need predictable cross-runtime behavior should declare `access.mode` explicitly.
- Surface secrets are runtime env, not inline manifest secrets.
- WhatsApp does not currently have a portable token-secret field; QR/session auth remains runtime-defined.

### ID Sources

For Discord, the identifiers are copied from Discord Developer Mode:

- user ID
- guild/server ID
- channel ID

These are low-level identifiers, but they are stable and map cleanly to allowlist semantics.

For Telegram, the identifiers are the bot-visible numeric ids:

- user ID
- chat ID

For WhatsApp and Slack, identifiers are runtime-facing platform identifiers:

- WhatsApp user or phone identity
- WhatsApp group id
- Slack user id
- Slack channel id

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
- Live smoke status:
  - `openclaw` Discord was verified end to end
  - `picoclaw` Discord was verified end to end
  - `tinyclaw` Discord was verified end to end as a paired DM surface

### Telegram

| Runtime | Supported Access | Notes |
|--------|------------------|-------|
| `openclaw` | `pairing`, `allowlist`, `open` | Supports DM and group/chat policy lowering. |
| `picoclaw` | `open`, `allowlist` | Supports Telegram token wiring and user allowlists. Chat allowlists are not lowered in v0.1. |
| `tinyclaw` | `pairing` | Telegram client is pairing-gated. Declarative user/chat allowlists are not supported in Spawnfile v0.1. |

### Practical Meaning

- `openclaw` is also the best current target for full portable Telegram policy.
- `picoclaw` is a good target for token-based Telegram plus simple user allowlists.
- `tinyclaw` supports Telegram as a paired DM-style surface, not as a declarative allowlist surface.
- Live smoke status:
  - `tinyclaw` Telegram was verified end to end with pairing
  - `openclaw` Telegram was verified end to end with `access.mode: open`
  - `picoclaw` Telegram was verified end to end with `access.mode: open`

### WhatsApp

| Runtime | Supported Access | Notes |
|--------|------------------|-------|
| `openclaw` | `pairing`, `allowlist`, `open` | Supports DM and group policy lowering. |
| `picoclaw` | `open`, `allowlist` | Supports user allowlists. Portable group allowlists are not lowered in Spawnfile v0.1. |
| `tinyclaw` | `pairing` | WhatsApp is pairing-gated. Declarative user/group allowlists are not supported in Spawnfile v0.1. |

### Practical Meaning

- `openclaw` is the strongest current target for portable WhatsApp policy.
- `picoclaw` is a good target for simple WhatsApp ingress and user allowlists.
- `tinyclaw` supports WhatsApp as a pairing-gated surface only.
- Live smoke status:
  - `openclaw` WhatsApp was verified end to end
  - `picoclaw` WhatsApp is still blocked in the pinned artifact because `whatsapp_native` is not compiled into the shipped binary
  - `tinyclaw` WhatsApp is still blocked in the shipped container because the upstream client needs a browser runtime

### Slack

| Runtime | Supported Access | Notes |
|--------|------------------|-------|
| `openclaw` | `pairing`, `allowlist`, `open` | Requires both bot and app/socket tokens. Supports DM and channel policy lowering. |
| `picoclaw` | `open`, `allowlist` | Requires both bot and app/socket tokens. Portable channel allowlists are not lowered in Spawnfile v0.1. |
| `tinyclaw` | unsupported | TinyClaw does not support Slack in Spawnfile v0.1. |

### Practical Meaning

- `openclaw` is the current reference target for portable Slack policy.
- `picoclaw` supports token-based Slack ingress plus user allowlists, but not channel allowlists.
- `tinyclaw` currently has no Spawnfile Slack surface.
- Live smoke status:
  - `openclaw` Slack was verified end to end
  - `picoclaw` Slack was verified end to end
  - `picoclaw` replies to channel messages in Slack threads; direct messages reply inline

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

Spawnfile lowers Telegram into the same richer OpenClaw channel surface:

- `dmPolicy`
- `groupPolicy`
- `allowFrom`
- `groups`

Spawnfile lowers WhatsApp and Slack into the same richer OpenClaw channel surface:

- WhatsApp lowers into `dmPolicy`, `groupPolicy`, `allowFrom`, and `groups`
- Slack lowers into `mode: socket`, `dmPolicy`, `groupPolicy`, `allowFrom`, and `channels`

### PicoClaw

Spawnfile lowers Discord into PicoClaw's simpler channel config:

- `token`
- `allow_from`
- `mention_only`

PicoClaw's user allowlists map well. Guild/channel allowlists do not currently have a portable lowering in Spawnfile.

Spawnfile lowers Telegram into PicoClaw's simpler channel config:

- `token`
- `allow_from`

User allowlists map well. Portable chat allowlists do not currently have a direct lowering in Spawnfile v0.1.

Spawnfile lowers WhatsApp and Slack into PicoClaw's simpler channel config:

- WhatsApp lowers into `enabled`, `use_native`, and optional `allow_from`
- Slack lowers into `enabled`, `group_trigger.mention_only`, and optional `allow_from`

User allowlists map well. Portable group or channel allowlists do not currently have a direct lowering in Spawnfile v0.1.
For Slack specifically, PicoClaw answers channel messages in a thread under the inbound message and answers direct messages inline.

### TinyClaw

Spawnfile lowers Discord, Telegram, and WhatsApp into TinyClaw's channel client config and starts the corresponding worker processes in the generated container.

But the upstream runtime behavior remains pairing-based and DM-oriented, so Spawnfile rejects richer Discord, Telegram, and WhatsApp access shapes for TinyClaw at compile time. Spawnfile also rejects Slack entirely for TinyClaw in v0.1.

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
