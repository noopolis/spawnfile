# Communication Surfaces

This document defines the portable communication-surface model that sits on top of `SPEC.md`.

`SPEC.md` remains the canonical source schema. This file makes three things explicit:

- what an agent surface is
- how agent surfaces differ from `team.networks[]`
- which runtimes support which portable surface shapes

---

## Purpose

A **surface** is an agent-level communication capability: a place where one concrete agent can exchange messages with humans, systems, or other agents. Surfaces are declared on agent manifests, validated at compile time, and lowered into runtime-native config.

A **team network** is a team-level organizational communication topology under `team.networks[]`. It describes rooms/channels that a team owns and that Spawnfile can compile, provision, bind, or validate. Moltnet is the first provider for this contract; future providers can use the same model if Spawnfile can manage their shared topology.

Team manifests do not declare `surfaces`. Concrete agent manifests declare `surfaces`; team manifests declare `networks`.

Spawnfile has a write-only runtime boundary. It does not read spawned runtimes to discover account IDs, infer live membership, or update rosters from runtime state. Roster addresses are emitted only when they are derivable from the manifest or explicitly authored through `identity`. `spawnfile status --live` may read declared provider metadata for diagnostics, as defined in `STATUS.md`, but those observations never update rosters or source.

---

## Current Portable Surfaces

Spawnfile v0.1 standardizes these agent surfaces:

- `discord`
- `telegram`
- `whatsapp`
- `slack`
- `moltnet`
- `webhook`

Portable HTTP ingress is not part of this alpha schema. Runtime-native HTTP APIs may exist through runtime-specific options, but they are not portable Spawnfile surfaces and do not appear in rosters.

```yaml
surfaces:
  discord:
    identity:
      user_id: "987654321098765432"
    access:
      mode: allowlist
      users: ["987654321098765432"]
    bot_token_secret: DISCORD_BOT_TOKEN
  telegram:
    identity:
      user_id: "123456789"
      username: "research_bot"
    access:
      mode: allowlist
      users: ["123456789"]
      chats: ["-1001234567890"]
    bot_token_secret: TELEGRAM_BOT_TOKEN
  whatsapp:
    identity:
      phone: "+15551234567"
    access:
      mode: allowlist
      users: ["15551234567"]
      groups: ["120363400000000000@g.us"]
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
          wake: all
      dms:
        enabled: true
        wake: never
  webhook:
    url: "https://my-service.example.com/callbacks"
    signing_secret: WEBHOOK_SECRET
```

---

## Surface Identity

`identity` is optional opt-in roster metadata. It tells the compiler which account/address to advertise when the agent is visible in a team-context roster. It does not provision an account, guarantee provider-side reachability, or permit Spawnfile to read runtime state.

| Surface | Identity fields | Roster address |
|---|---|---|
| `discord` | `user_id` | `addresses.discord.user_id` |
| `telegram` | `user_id` and/or `username` | `addresses.telegram.user_id`, `addresses.telegram.username` |
| `whatsapp` | `phone` | `addresses.whatsapp.phone` |
| `slack` | `user_id` | `addresses.slack.user_id` |
| `moltnet` | derived from team network attachment | `addresses.moltnet.<network_id>.fqid` |

If a chat surface is declared without `identity`, rosters may list that surface while omitting an address. Teammates then rely on native discovery: mentions, channel membership, replies, or provider UI.

---

## Access Rules

- Discord access uses `pairing`, `allowlist`, or `open`. `users`, `guilds`, and `channels` are only valid with `allowlist`.
- Telegram access uses `pairing`, `allowlist`, or `open`. `users` and `chats` are only valid with `allowlist`.
- WhatsApp access uses `pairing`, `allowlist`, or `open`. `users` and `groups` are only valid with `allowlist`.
- Slack access uses `pairing`, `allowlist`, or `open`. `users` and `channels` are only valid with `allowlist`.
- If an access mode is omitted and allowlist entries are present, the effective mode is `allowlist`.
- If an access block is omitted entirely, behavior is runtime-defined and is not portable.
- Surface secrets are runtime env references, not inline manifest secrets.
- WhatsApp does not currently have a portable token-secret field; QR/session auth remains runtime-defined.

---

## Moltnet

Moltnet is both an agent surface and the first `team.networks[]` provider.

Agent-side Moltnet surface:

```yaml
surfaces:
  moltnet:
    - network: local_lab
      rooms:
        research:
          wake: all
      dms:
        enabled: true
        wake: never
```

Team-side network:

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
- `wake` may be `all`, `mentions`, `thread_only`, or `never`.
- `reply` may be only `auto` or `never` in this alpha. `manual` is not portable.
- Moltnet FQIDs are derivable and should be emitted into context-scoped rosters.
- A parent room member may name a direct child-team slot. The compiler expands that slot through the child team's representative chain and attaches only selected concrete representatives.
- Parent networks do not autojoin every descendant. Non-representative child members do not receive parent room attachments.
- Moltnet member IDs are direct agent member slot IDs and must be unique across the reachable nested team graph.
- Reusing the same network id across teams is allowed. Compatible duplicate attachments for the same `(network_id, member_id)` merge rooms; incompatible duplicates fail compilation.
- `spawnfile status --live` may inspect Moltnet metadata for declared networks: rooms, expected members, live participants, connected/disconnected bridge state, and direct-message capability. Wake delivered/failed events and debug lifecycle events are future metadata extensions, after Moltnet exposes a bounded metadata endpoint; debug events also require debug mode to be declared.
- Moltnet status inspection is metadata-only. It must not request or render message bodies, and missing operator credentials render the network layer `unknown` instead of attempting anonymous access.

---

## Runtime Support Matrix

The portable schema is broader than any single runtime. A conforming compiler validates the declared surface against the selected runtime and fails early when the runtime cannot preserve it.

### Discord

| Runtime | Supported Access | Notes |
|---|---|---|
| `openclaw` | `pairing`, `allowlist`, `open` | Supports user, guild, and channel policy lowering. Channel allowlists currently require exactly one guild in Spawnfile lowering. |
| `picoclaw` | `open`, `allowlist` | Supports Discord token wiring and user allowlists. Guild/channel allowlists are not lowered in v0.1. |

### Telegram

| Runtime | Supported Access | Notes |
|---|---|---|
| `openclaw` | `pairing`, `allowlist`, `open` | Supports DM and group/chat policy lowering. |
| `picoclaw` | `open`, `allowlist` | Supports Telegram token wiring and user allowlists. Chat allowlists are not lowered in v0.1. |

### WhatsApp

| Runtime | Supported Access | Notes |
|---|---|---|
| `openclaw` | `pairing`, `allowlist`, `open` | Supports DM and group policy lowering. |
| `picoclaw` | `open`, `allowlist` | Supports user allowlists. Portable group allowlists are not lowered in Spawnfile v0.1. |

### Slack

| Runtime | Supported Access | Notes |
|---|---|---|
| `openclaw` | `pairing`, `allowlist`, `open` | Requires both bot and app/socket tokens. Supports DM and channel policy lowering. |
| `picoclaw` | `open`, `allowlist` | Requires both bot and app/socket tokens. Portable channel allowlists are not lowered in Spawnfile v0.1. |

### Moltnet

| Runtime | Supported Shape | Notes |
|---|---|---|
| `openclaw` | team-network attachments | Lowers generated Moltnet client config and skill installation when artifacts are available. |
| `picoclaw` | team-network attachments | Lowers generated Moltnet client config and skill installation when artifacts are available. |
| `pi` | supported | Lowers generated Moltnet client config, skill installation, persistent open-token directories, and `moltnet node` bridge configs that deliver wakes through the generated Pi app control endpoint. |

### Webhook

| Runtime | Supported | Notes |
|---|---|---|
| `openclaw` | not yet | Webhook delivery support is planned. |
| `picoclaw` | not yet | Webhook delivery support is planned. |

Webhook is a push surface: the agent delivers events to a caller-owned callback URL. Delivery is fire-and-forget. When `signing_secret` is configured, payloads are signed with HMAC-SHA256.

---

## Runtime Verification

The Moltnet team-network contract requires an opt-in, release-gating E2E that compiles, builds, runs, and verifies a real team conversation through Moltnet room history. The fixture should include a parent team, nested child teams, explicit representatives, parent-room membership expansion, non-representative exclusion, and one representative answering in both parent and child rooms.

Slack, Discord, Telegram, and WhatsApp do not need equivalent team-chat E2Es for this contract because Spawnfile only carries their declared identity/roster data.

---

## Relationship To Other Specs

- `SPEC.md`
  Defines the canonical manifest schema for `surfaces` and `team.networks`.
- `COMPILER.md`
  Defines when surface support is resolved, validated, and emitted into rosters.
- `CONTAINERS.md`
  Defines how surface secrets are emitted into `.env.example` and injected at run time.
- `RUNTIMES.md`
  Tracks which runtimes exist; this file tracks what the current standardized surfaces mean on those runtimes.
