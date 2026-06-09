---
title: Writing a Spawnfile
description: Guide to the common Spawnfile manifest fields for agents and teams, with examples for the main portable sections.
---

A Spawnfile manifest is a YAML file named exactly `Spawnfile` (no extension) at the root of your agent or team project directory. It must be valid YAML 1.2 and UTF-8 encoded with no BOM.

This guide covers the common portable fields used by agent and team manifests. For full normative details, including team-specific fields, see the [spec](/spec/spec/) and the [Teams guide](/guides/teams/).

## Required Fields

Every manifest must declare these three fields:

```yaml
spawnfile_version: "0.1"   # string, not number
kind: agent                # "agent" or "team"
name: my-agent             # non-empty string, no whitespace
```

- `spawnfile_version` must be a quoted string matching a published spec version. Currently the only valid value is `"0.1"`.
- `kind` is either `agent` (a single agent, possibly with subagents) or `team` (an organizational unit of multiple agents).
- `name` identifies the agent or team. It must not contain whitespace.

## runtime

The `runtime` field declares which runtime adapter should compile the manifest. It is required for agents.

Short form:

```yaml
runtime:
  name: openclaw
```

Long form with options:

```yaml
runtime:
  name: openclaw
  options:
    profile: default
```

The short form is equivalent to the long form with an empty `options` map. The `options` object is adapter-specific and varies by runtime.

For agents with subagents, the parent's runtime is inherited. Subagents must not declare a different runtime than their parent.

## workspace

The `workspace` block declares portable markdown surfaces, attached working resources, and local skills for an agent. `workspace.docs` defines the agent's identity, behavior, and operating context. All doc fields are optional.

```yaml
workspace:
  docs:
    identity: IDENTITY.md
    soul: SOUL.md
    system: AGENTS.md
    memory: MEMORY.md
    heartbeat: HEARTBEAT.md
    extras:
      user: USER.md
      notes: docs/NOTES.md
  skills:
    - ref: ./skills/web_search
```

Each doc path must resolve to a UTF-8 Markdown file. See the [Agent Docs guide](/guides/agent-docs/) for what goes in each role.

Paths must use forward slashes. Parent-relative paths are valid when shared docs or skills live next to a nested organization directory, for example `../.claude/skills/web_search`. Symlinks are not followed during compilation.

Teams declare shared workspace material under `shared.workspace` instead of `workspace`.

## schedule

The `schedule` block declares agent-owned wake intent. It is valid only on agent manifests.

```yaml
schedule:
  kind: cron
  cron: "0 9 * * *"
  timezone: UTC
  prompt: "Read heartbeat context and complete one bounded research iteration."
```

Supported forms:

- `kind: cron` with a non-empty `cron` expression.
- `kind: every` with a non-empty interval such as `2h` or `24h`.
- `kind: disabled` to declare that automatic wake is intentionally off.

`cron` and `every` schedules may include `timezone` and `prompt`. The prompt should describe one bounded wake iteration and usually complements `workspace.docs.heartbeat`.

Schedule declarations are portable wake intent. In this alpha, runtimes may report schedule lowering as degraded when they validate the intent but do not emit a native scheduler yet.

In v0.1, `schedule.kind: cron` lowers to native scheduler artifacts for TinyClaw
and PicoClaw. `schedule.kind: every` is valid portable intent, but those
adapters currently report it as degraded.

## skills

The `workspace.skills` list declares skill directories available to the agent. Each entry must have a `ref` pointing to a directory that contains a `SKILL.md` file.

```yaml
workspace:
  skills:
    - ref: ./skills/web_search
      requires:
        mcp:
          - web_search
```

The optional `requires.mcp` list names MCP servers that the skill depends on. The compiler validates these names against the agent's visible MCP server list and reports an error if any required server is missing.

Teams can declare inherited skill directories under `shared.workspace.skills` with the same shape.

See [Skills and MCP](/guides/skills-and-mcp/) for details.

## environment.mcp_servers

The `environment.mcp_servers` list declares MCP (Model Context Protocol) servers available to the agent.

```yaml
environment:
  mcp_servers:
    - name: web_search
      transport: streamable_http
      url: https://search.mcp.example.com/mcp
      auth:
        secret: SEARCH_API_KEY
    - name: local_index
      transport: stdio
      command: node
      args:
        - ./tools/index-mcp.js
```

Each entry must have a unique `name` within its manifest scope. The `transport` field must be one of `stdio`, `streamable_http`, or `sse`.

Transport requirements:
- `stdio` must declare `command`. It may declare `args` and `env`.
- `streamable_http` must declare `url`.
- `sse` must declare `url`.

The `auth.secret` value should be an environment variable name, not a literal credential.

## execution

The `execution` block declares portable intent about how the agent should run. Compilers map these values to runtime-native configuration.

```yaml
execution:
  model:
    primary:
      provider: anthropic
      name: claude-sonnet-4-5
      auth:
        method: claude-code
    fallback:
      - provider: openai
        name: gpt-4o-mini
        auth:
          method: codex
      - provider: local
        name: qwen2.5:14b
        auth:
          method: none
        endpoint:
          compatibility: openai
          base_url: http://host.docker.internal:11434/v1
  sandbox:
    mode: workspace        # workspace | sandboxed | unrestricted
```

### Model

- `primary.provider` and `primary.name` are required if `execution.model` is present.
- `fallback` is an optional ordered list of fallback models.
- Each model target (primary or fallback) may declare inline `auth` and `endpoint`.

### Model Auth

Each model target may declare an `auth` block with a `method` field. Supported methods in v0.1:

| Method | Description |
|--------|-------------|
| `api_key` | Uses an environment variable for the provider API key. Default for built-in providers. |
| `claude-code` | Imports the local Claude Code CLI credential store. |
| `codex` | Imports the local Codex CLI credential store. |
| `none` | No auth required. Default for `provider: local`. |

For `api_key` auth on custom or local models, use `auth.key` to name the env var:

```yaml
auth:
  method: api_key
  key: MY_CUSTOM_API_KEY
```

### Custom Endpoints

Models using `provider: local` or `provider: custom` must declare an `endpoint` block:

```yaml
endpoint:
  compatibility: openai    # openai | anthropic
  base_url: http://host.docker.internal:11434/v1
```

The `compatibility` field tells the runtime which API format the endpoint speaks. The `base_url` is the endpoint URL. Built-in providers (`anthropic`, `openai`) must not declare `endpoint`.

### Workspace Resources

`workspace.resources` attach project resources to the generated runtime workspace. The `mount` path is where the agent sees the resource:

```yaml
workspace:
  resources:
    - id: product
      kind: git
      url: https://github.com/example/product.git
      branch: main
      mount: ./repos/product
      mode: mutable
    - id: agent-scratch
      kind: volume
      mount: ./scratch
      mode: mutable
```

`./...` and `${workspace}/...` mounts are workspace-relative. Absolute paths are advanced container paths. Mounts must not point at the workspace root, contain `..`, or overlap another resource mount for the same concrete agent.

Spawnfile prepares the real git clone or volume in managed backing storage, then creates a symlink inside each agent workspace. If the target path already exists and is not the expected symlink, startup fails instead of hiding those files. Existing git backing directories are reused only when their remote and selected branch, tag, or ref match the declaration.

By default resources are `sharing: per_agent`, so each concrete agent gets its own backing resource. Use `sharing: team` only for shared volumes where team members should write to the same files. Git resources cannot use `sharing: team`; declare the git resource once at team level under `shared.workspace.resources` and let each concrete agent receive its own checkout.

### Sandbox

- `mode: workspace` restricts the agent to its workspace directory.
- `mode: sandboxed` applies stricter containment (runtime-dependent).
- `mode: unrestricted` gives the agent full filesystem access.

## environment

The `environment` block declares runtime and image inputs. `environment.env` carries non-secret values, `environment.secrets` names required credentials, and `environment.packages` declares package inputs for the runtime or container image.

```yaml
environment:
  env:
    LOG_LEVEL: info
  secrets:
    - name: SEARCH_API_KEY
      required: true
    - name: MEMORY_API_KEY
      required: false
  packages:
    - id: github-cli
      manager: apt
      name: gh
```

Values in `environment.env` must be strings. The compiler warns when a required secret is not present in the execution environment used for compilation.

Declared secrets are also used by the auth/run workflow. `spawnfile auth sync --env-file .env` copies required secret values into the selected auth profile and fails if a required value is missing. Optional secrets are copied only when present. `spawnfile run --env-file .env` can inject the same env file directly into the generated Docker run environment.

Teams can declare inherited environment inputs under `shared.environment` with the same shape.

Package declarations lower into generated container images:

- `manager: apt` installs a Debian package with `apt-get install`; `version` becomes `name=version`.
- `manager: npm` installs a global npm package with `npm install -g`; `version` becomes `name@version`. `scope`, when present, must be `global`.
- `manager: pipx` installs a Python CLI package with `pipx install`; `version` becomes `name==version`.

Inherited team packages are merged into each direct member. If a member declares the same `manager` and `name`, the member-local package wins. If several agents are packed into the same generated container target and their effective package definitions conflict, the compiler fails rather than picking one silently.

This is the intended pattern for external credentials such as repository tokens:

```yaml
environment:
  secrets:
    - name: GH_TOKEN
      required: true
```

```bash
spawnfile auth sync . --profile dev --env-file ./ops/secrets/agent.env
spawnfile run . --auth-profile dev
```

## policy

The `policy` block controls how strictly the compiler enforces capability preservation. It is optional and defaults to warning mode.

```yaml
policy:
  mode: strict      # strict | warn | permissive (default: warn)
  on_degrade: error  # error | warn | allow (default: warn)
```

- `strict` -- the compiler fails on any capability it cannot verify or preserve.
- `warn` -- the compiler emits a warning and may continue.
- `permissive` -- the compiler continues but still records the outcome in the compile report.

`on_degrade` controls behavior when a capability is partially mapped but not fully equivalent:
- `error` -- compilation fails.
- `warn` -- compilation continues with a warning.
- `allow` -- compilation continues silently.

## surfaces

The `surfaces` block declares communication channels for the agent. Spawnfile v0.1 alpha standardizes Discord, Telegram, WhatsApp, Slack, Moltnet, and Webhook. Portable HTTP ingress is not part of this alpha surface schema.

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
    identity:
      user_id: "U1234567890"
    access:
      mode: allowlist
      users:
        - "U1234567890"
      channels:
        - "C1234567890"
    bot_token_secret: SLACK_BOT_TOKEN
    app_token_secret: SLACK_APP_TOKEN
  moltnet:
    - network: local_lab
      rooms:
        research:
          wake: all
```

Optional `identity` fields advertise the agent's own account in generated rosters. They do not provision accounts or cause Spawnfile to read runtime state. Supported identity fields are Discord `user_id`, Telegram `user_id` and/or `username`, WhatsApp `phone`, and Slack `user_id`.

### Discord Fields

| Field | Description |
|-------|-------------|
| `bot_token_secret` | Env var name for the Discord bot token. Defaults to `DISCORD_BOT_TOKEN`. |
| `access.mode` | Access policy: `pairing`, `allowlist`, or `open`. |
| `access.users` | Allowed Discord user IDs. |
| `access.guilds` | Allowed Discord guild/server IDs. |
| `access.channels` | Allowed Discord channel IDs. |

### Telegram Fields

| Field | Description |
|-------|-------------|
| `bot_token_secret` | Env var name for the Telegram bot token. Defaults to `TELEGRAM_BOT_TOKEN`. |
| `access.mode` | Access policy: `pairing`, `allowlist`, or `open`. |
| `access.users` | Allowed Telegram user IDs. |
| `access.chats` | Allowed Telegram chat IDs. |

### WhatsApp Fields

| Field | Description |
|-------|-------------|
| `access.mode` | Access policy: `pairing`, `allowlist`, or `open`. |
| `access.users` | Allowed WhatsApp user identifiers. |
| `access.groups` | Allowed WhatsApp group identifiers. |

WhatsApp does not have a portable token secret field. QR/session auth is runtime-defined.

### Slack Fields

| Field | Description |
|-------|-------------|
| `bot_token_secret` | Env var name for the Slack bot token. Defaults to `SLACK_BOT_TOKEN`. |
| `app_token_secret` | Env var name for the Slack app-level socket token. Defaults to `SLACK_APP_TOKEN`. |
| `access.mode` | Access policy: `pairing`, `allowlist`, or `open`. |
| `access.users` | Allowed Slack user IDs. |
| `access.channels` | Allowed Slack channel IDs. |

Slack requires both a bot token and an app-level socket token.

### Access Rules

Chat surfaces follow the same access-mode pattern:

- If `access.mode` is omitted and any allowlist identifiers are present, the effective mode is `allowlist`.
- Allowlist identifiers are only valid with `allowlist` mode.
- `allowlist` must declare at least one identifier list.
- Discord uses `users`, `guilds`, and `channels`.
- Telegram uses `users` and `chats`.
- WhatsApp uses `users` and `groups`.
- Slack uses `users` and `channels`.
- If `access` is omitted entirely, the effective behavior is runtime-defined and not currently portable. Projects that need predictable cross-runtime behavior should declare `access.mode` explicitly.

Moltnet attachments reference team-declared networks and rooms. Moltnet `reply` policy is only `auto` or `never` in this alpha.

### Runtime Support

Not all runtimes support all access shapes for every surface:

**Discord:**
- `openclaw` supports `pairing`, `allowlist`, and `open`.
- `picoclaw` supports `open` and user allowlists.
- `tinyclaw` supports `pairing` only (DM-oriented).

**Telegram:**
- `openclaw` supports `pairing`, `allowlist`, and `open`.
- `picoclaw` supports `open` and user allowlists.
- `tinyclaw` supports `pairing` only.

**WhatsApp:**
- `openclaw` supports `pairing`, `allowlist`, and `open`.
- `picoclaw` supports `open` and user allowlists.
- `tinyclaw` supports `pairing` only.

**Slack:**
- `openclaw` supports `pairing`, `allowlist`, and `open`.
- `picoclaw` supports `open` and user allowlists.
- `tinyclaw` does not support Slack.

The compiler validates the declared surface against the selected runtime and fails early on unsupported combinations.

### Constraints

- Only agent manifests may declare `surfaces`. Team manifests must not.
- Subagents do not inherit parent `surfaces`.
- Surface auth secrets (like `DISCORD_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`) participate in the same auth profile and env validation path as model auth.

## subagents

The `subagents` list declares helper agents owned by the parent agent. Subagents are internal helpers, not team members.

```yaml
subagents:
  - id: researcher
    ref: ./subagents/researcher
  - id: critic
    ref: ./subagents/critic
```

Each subagent must have a unique `id` and a `ref` pointing to an agent source project (a directory with its own `Spawnfile`).

Subagents inherit the parent's runtime. They do not inherit the parent's `workspace` or `environment` declarations -- each subagent is a self-contained project.

For execution, the parent's `execution` is deep-merged with the subagent's local `execution`: objects merge recursively, scalars replace, arrays replace wholesale.

## Environment Variable Substitution

String values in a manifest may contain `${VAR}` or `${VAR:-default}` references that are resolved at manifest load time before schema validation.

```yaml
execution:
  model:
    primary:
      provider: ${PROVIDER:-anthropic}
      name: ${MODEL:-claude-sonnet-4-5}

environment:
  mcp_servers:
    - name: web_search
      transport: streamable_http
      url: ${SEARCH_MCP_URL}
```

If a referenced variable is not set and has no default, the compiler fails. Substitution is not recursive -- a resolved value containing `${...}` is treated as literal.

The `secrets[*].name` and `auth.secret` fields are not substituted. They reference environment variable names, not values.

## Metadata

Optional informational fields for project identity:

```yaml
description: "Research analyst agent"
author: noopolis
license: MIT
repository: https://github.com/noopolis/analyst-agent
```

These are passed through to the compile report but do not affect compilation logic.

## Complete Example

Here is a full agent manifest showing all major sections:

```yaml
spawnfile_version: "0.1"
kind: agent
name: analyst

runtime:
  name: openclaw

execution:
  model:
    primary:
      provider: anthropic
      name: claude-sonnet-4-5
      auth:
        method: claude-code
    fallback:
      - provider: openai
        name: gpt-4o-mini
        auth:
          method: codex
  sandbox:
    mode: workspace

workspace:
  docs:
    identity: IDENTITY.md
    soul: SOUL.md
    system: AGENTS.md
    memory: MEMORY.md
    heartbeat: HEARTBEAT.md
  skills:
    - ref: ./skills/web_search
      requires:
        mcp:
          - web_search

surfaces:
  discord:
    access:
      users:
        - "987654321098765432"
    bot_token_secret: DISCORD_BOT_TOKEN
  telegram:
    access:
      users:
        - "123456789"
    bot_token_secret: TELEGRAM_BOT_TOKEN

environment:
  mcp_servers:
    - name: web_search
      transport: streamable_http
      url: https://search.mcp.example.com/mcp
      auth:
        secret: SEARCH_API_KEY
  secrets:
    - name: SEARCH_API_KEY
      required: true

policy:
  mode: warn
  on_degrade: warn
```
