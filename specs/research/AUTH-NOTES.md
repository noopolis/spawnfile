# Runtime Auth Notes

Research snapshot for how the active runtimes currently handle authentication and credential material.

Purpose:

- record the actual auth surfaces exposed by the pinned runtimes
- separate plain secrets from persistent credential stores and interactive session state
- guide a user-friendly Spawnfile auth system that does not require manual container surgery

This file is informative, not normative.

Current implementation status:

- Spawnfile now supports manifest-level model auth intent inline on each model target via `execution.model.primary.auth` and `execution.model.fallback[*].auth`.
- Spawnfile also supports `endpoint` on `custom` and `local` model targets for compatibility-aware custom backends.
- `spawnfile auth sync` is the primary happy path for importing auth material into a local profile.
- `spawnfile build` stays secrets-free.
- `spawnfile run --auth-profile ...` validates declared auth intent and mounts or patches runtime-native auth material at run time.
- Communication surface auth is still out of scope in the current implementation.

---

## Why This Matters

The container/compiler work is already good enough to build runnable images, but real deployments still hit an auth wall:

- model/provider credentials need to exist
- channel credentials need to exist
- some runtimes need persistent auth stores or session directories
- some workflows depend on Claude Code CLI or Codex CLI credentials already present on the machine

So "auth" is not one thing. Across the runtimes it falls into three buckets:

1. plain secret inputs
2. persistent credential stores
3. interactive session state

Spawnfile should model all three.

---

## Auth Buckets

### 1. Plain Secret Inputs

These are values that can be provided as env vars, config values, file contents, or secret references:

- API keys
- bot tokens
- app tokens
- webhook secrets
- channel secrets
- gateway tokens/passwords

This is the easiest class for Spawnfile to support.

### 2. Persistent Credential Stores

These are runtime-owned files that represent a durable login or profile store:

- `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- `~/.picoclaw/auth.json`
- `.tinyagi/settings.json`
- `~/.codex/auth.json`
- `~/.claude/.credentials.json`

These are not just "secret strings". They are runtime- or CLI-specific auth stores.

### 3. Interactive Session State

These are auth flows that create durable state by login, pairing, or QR scan:

- WhatsApp session directories
- OpenClaw paired device credentials under `~/.openclaw/credentials/`
- provider OAuth flows that mint refreshable credentials

This class usually cannot be solved by static env vars alone.

---

## OpenClaw

### Model And Provider Auth

OpenClaw has the most mature auth system of the three runtimes.

- It uses per-agent auth profiles in `auth-profiles.json`.
- It supports API key and token profiles.
- It also supports SecretRef-style indirection for many secret-bearing config fields.
- It has native login/bootstrap flows for some providers, for example `openclaw models auth login-github-copilot`.

Useful evidence:

- [README.md](../../runtimes/openclaw/README.md)
- [authentication.md](../../runtimes/openclaw/docs/gateway/authentication.md)
- [secrets.md](../../runtimes/openclaw/docs/gateway/secrets.md)
- [cli-credentials.ts](../../runtimes/openclaw/src/agents/cli-credentials.ts)

### CLI Credential Imports

OpenClaw already understands local CLI credential stores:

- Claude Code credentials from `~/.claude/.credentials.json`
- Codex credentials from `~/.codex/auth.json`
- macOS keychain fallbacks for both

So OpenClaw proves that "import local machine auth into runtime auth" is viable.

### Gateway Auth

OpenClaw has a real runtime/gateway auth surface:

- `gateway.auth.token`
- `gateway.auth.password`
- env fallbacks like `OPENCLAW_GATEWAY_TOKEN`
- device pairing / issued device tokens for clients

Non-loopback gateway exposure expects auth to be configured.

### Channel Auth

OpenClaw has the broadest channel auth/config surface:

- direct env/config tokens for Telegram, Discord, Slack, etc.
- token-file and secret-file support on some channels
- credential directories for paired/session-based channels like WhatsApp
- webhook credentials for channels like LINE, Google Chat, Mattermost, BlueBubbles

Important detail:

- OpenClaw already separates "user-supplied secrets" from runtime-managed credentials in its SecretRef surface.
- That is a useful precedent for Spawnfile.

### OpenClaw Takeaway

OpenClaw is the clearest proof that Spawnfile needs all of:

- env/file secret injection
- credential-file and credential-dir handling
- explicit exclusion of runtime-minted state from generic secret resolution

---

## PicoClaw

### Model And Provider Auth

PicoClaw supports both static-key and runtime-managed auth patterns.

- Static provider auth lives in `model_list[].api_key`.
- Some providers use `auth_method`, including OAuth-style flows.
- The runtime has `picoclaw auth login --provider ...`.
- OAuth credentials are stored in `~/.picoclaw/auth.json`.

Useful evidence:

- [README.md](../../runtimes/picoclaw/README.md)
- [ANTIGRAVITY_AUTH.md](../../runtimes/picoclaw/docs/ANTIGRAVITY_AUTH.md)

It also supports credential encryption for stored `api_key` entries, which is useful operationally but is still conceptually a config-backed secret.

### CLI Credential Dependencies

PicoClaw can also depend on CLI credential stores:

- `claude-cli`
- `codex-cli`

The code explicitly reads Codex credentials from `~/.codex/auth.json` or `CODEX_HOME/auth.json`.

Useful evidence:

- [codex_cli_credentials.go](../../runtimes/picoclaw/pkg/providers/codex_cli_credentials.go)
- [factory.go](../../runtimes/picoclaw/pkg/providers/factory.go)

### Gateway Auth

PicoClaw's web console currently does not have a strong auth surface and should not be exposed casually.

That means Spawnfile should treat PicoClaw runtime exposure more conservatively than OpenClaw.

### Channel Auth

PicoClaw has a real `channels` config surface in `config.json`.

Examples:

- Telegram: token
- Discord: token
- Slack: bot token + app token
- LINE: channel secret + channel access token + webhook path
- Matrix: access token
- WeCom: webhook URL / token
- WhatsApp: QR/session state via workspace or `session_store_path`

Useful evidence:

- [README.md](../../runtimes/picoclaw/README.md)
- [gateway.go](../../runtimes/picoclaw/pkg/gateway/gateway.go)

### PicoClaw Takeaway

PicoClaw strongly reinforces this split:

- static secret inputs for many channels
- auth store file for provider OAuth
- session directory for WhatsApp
- optional CLI credential store reuse for Codex and Claude

---

## TinyClaw

### Model And Provider Auth

TinyClaw is the simplest auth model conceptually, but not the smallest operationally.

- Built-in provider tokens are stored directly in `.tinyagi/settings.json` under `models.<provider>.auth_token`.
- Custom providers store `api_key` plus `base_url` and `harness`.
- The runtime then exports those credentials to the invoked CLI as env vars.

Useful evidence:

- [README.md](../../runtimes/tinyclaw/README.md)
- [invoke.ts](../../runtimes/tinyclaw/packages/core/src/invoke.ts)

### CLI Credential Dependencies

TinyClaw explicitly depends on:

- Claude Code CLI for Anthropic
- Codex CLI for OpenAI

So even when TinyClaw stores provider tokens in `settings.json`, its real execution model is still CLI-centric. That means Spawnfile should treat `.claude` and `.codex` as first-class auth materials for TinyClaw deployments.

Useful evidence:

- [INSTALL.md](../../runtimes/tinyclaw/docs/INSTALL.md)
- [README.md](../../runtimes/tinyclaw/README.md)

### Channel Auth

TinyClaw stores channel config in `.tinyagi/settings.json`:

- `channels.discord.bot_token`
- `channels.telegram.bot_token`
- WhatsApp uses persistent session state under `.tinyagi/whatsapp-session`

At runtime the daemon writes selected tokens into `.env` for the Node channel clients.

Useful evidence:

- [README.md](../../runtimes/tinyclaw/README.md)
- [common.sh](../../runtimes/tinyclaw/lib/common.sh)
- [daemon.sh](../../runtimes/tinyclaw/lib/daemon.sh)

### TinyClaw Takeaway

TinyClaw is user-friendly at the runtime level because everything ends up in `settings.json`, but Spawnfile should not copy that design directly:

- `settings.json` mixes config and secrets
- CLI credentials and channel session state still exist beside it
- a generic Spawnfile solution should separate config from auth material more cleanly

---

## Cross-Runtime Conclusions

The active runtimes all need some combination of these auth material types:

| Auth Material | OpenClaw | PicoClaw | TinyClaw |
|---|---|---|---|
| Env secret | Yes | Yes | Yes |
| Secret file | Yes | Sometimes by config path | Indirectly via generated `.env` |
| Credential JSON store | Yes | Yes | Yes |
| Credential directory | Yes | Sometimes | Yes |
| QR/session directory | Yes | Yes | Yes |
| Runtime-native login command | Yes | Yes | Partly |
| Local Claude/Codex credential reuse | Yes | Yes | Yes |

So a Spawnfile auth system that only handles env vars will be insufficient.

---

## Best Spawnfile Direction

The most user-friendly direction is a hybrid model:

### 1. Keep Images Clean

`spawnfile build` should not bake credentials into the image layer by default.

That means:

- no committed secrets
- no baking local OAuth tokens into Docker image history
- no copying `.codex` or `.claude` into the image during build unless explicitly forced

Builds should stay credentials-free by default.

### 2. Add A Local Spawnfile Auth Store

Spawnfile should have its own local, gitignored auth home, something like:

```text
~/.spawnfile/auth/
  profiles/<name>/
    profile.json
    env/
    files/
    dirs/
```

The important part is not the exact path. The important part is that Spawnfile owns a local auth bundle/profile abstraction.

This is now implemented in first form under `~/.spawnfile/auth/profiles/<name>/`.

### 3. Support Four First-Class Auth Material Kinds

Spawnfile should support:

- `env_secret`
  - example: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DISCORD_BOT_TOKEN`
- `text_file`
  - example: LINE token file, gateway token file
- `credential_file`
  - example: `~/.picoclaw/auth.json`, `~/.codex/auth.json`, `~/.claude/.credentials.json`
- `credential_dir`
  - example: `~/.openclaw/credentials`, `.tinyagi/whatsapp-session`

That is the minimum set that matches what the runtimes actually do.

### 4. Default To Importing Existing Local Auth

For a local developer, the easiest flow is usually:

- import existing Claude Code auth
- import existing Codex auth
- import existing env/API keys
- optionally import runtime-native auth/session state

The current implementation already supports:

- `spawnfile auth sync <project> --profile <name> [--env-file .env]`
- `spawnfile auth import claude-code`
- `spawnfile auth import codex`
- `spawnfile auth import env`

This is much better than asking users to shell into containers and re-run login flows manually.

### 5. Keep Runtime-Specific Bootstrap As An Escape Hatch

Some auth cannot be imported cleanly ahead of time:

- QR-based WhatsApp login
- some provider OAuth flows
- channel pairing flows

For those, Spawnfile should expose bootstrap as a first-class concept instead of pretending everything is static config.

That could look like:

- `spawnfile auth bootstrap picoclaw.whatsapp`
- `spawnfile auth bootstrap openclaw.github-copilot`

The key is that Spawnfile owns the workflow, even when the runtime still performs the actual login.

### 6. Separate Build-Time From Run-Time Auth

Recommended contract:

- `spawnfile compile`
  - emits auth requirements metadata, including per-runtime-instance `model_auth_methods`
- `spawnfile build`
  - builds a clean image without secrets baked in
- `spawnfile run`
  - materializes the selected auth profile into env vars, files, and mounted dirs

This is safer and more user-friendly than stuffing credentials into the image build.

---

## Recommended Spawnfile UX

If Spawnfile wants to feel good, the user flow should be roughly:

```bash
spawnfile auth sync ./my-team --profile dev --env-file .env.models
spawnfile build ./my-team --tag my-team
spawnfile run ./my-team --auth-profile dev
```

And for surface-specific setup:

```bash
spawnfile auth set slack.bot_token --profile work
spawnfile auth set slack.app_token --profile work
spawnfile auth bootstrap whatsapp --runtime tinyclaw --profile personal
```

The big idea is:

- auth intent lives in the Spawnfile source
- auth is selected by logical profile
- Spawnfile maps it to runtime-native paths
- users do not have to hand-edit runtime config or exec into containers

---

## Immediate Recommendation For Milestone 3

Milestone 3 should not start by inventing a universal encrypted secret manager.

It should start by implementing the minimal practical model:

The remaining useful work in this area is not the basic profile/store model anymore. The next gaps are:

1. surface/channel auth on top of the model-auth layer
2. richer auth profile material kinds beyond env plus imported CLI stores
3. runtime-native bootstrap helpers for QR and OAuth onboarding flows
4. clearer auth status/inspection commands
5. optional deployment-oriented wrappers beyond local `spawnfile run`

If that works, then Spawnfile will already be dramatically better than handwritten deployments like `7-haunt`, without over-designing the first pass.
