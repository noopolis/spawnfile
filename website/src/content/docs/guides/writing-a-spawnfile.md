---
title: Writing a Spawnfile
description: Complete manifest reference covering every field in the Spawnfile format, with examples for each.
---

A Spawnfile manifest is a YAML file named exactly `Spawnfile` (no extension) at the root of your agent or team project directory. It must be valid YAML 1.2 and UTF-8 encoded with no BOM.

This guide covers every field the manifest supports.

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
runtime: openclaw
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

## docs

The `docs` block declares portable markdown surfaces that define the agent's identity, behavior, and operating context. All fields are optional.

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

Each path must resolve to a UTF-8 Markdown file within the project root. See the [Agent Docs guide](/guides/agent-docs/) for what goes in each role.

Paths must use forward slashes and must not escape the project root via `..` traversal. Symlinks are not followed during compilation.

## skills

The `skills` list declares skill directories available to the agent. Each entry must have a `ref` pointing to a directory that contains a `SKILL.md` file.

```yaml
skills:
  - ref: ./skills/web_search
    requires:
      mcp:
        - web_search
  - ref: ./skills/memory_store
    requires:
      mcp:
        - memory_store
```

The optional `requires.mcp` list names MCP servers that the skill depends on. The compiler validates these names against the agent's `mcp_servers` list and reports an error if any required server is missing.

See [Skills and MCP](/guides/skills-and-mcp/) for details.

## mcp_servers

The `mcp_servers` list declares MCP (Model Context Protocol) servers available to the agent.

```yaml
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
  workspace:
    isolation: isolated    # isolated | shared
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

### Workspace

- `isolation: isolated` means the agent gets its own workspace.
- `isolation: shared` means the agent shares a workspace with others.

### Sandbox

- `mode: workspace` restricts the agent to its workspace directory.
- `mode: sandboxed` applies stricter containment (runtime-dependent).
- `mode: unrestricted` gives the agent full filesystem access.

## env

A flat key-value map of non-secret environment values. Values must be strings.

```yaml
env:
  LOG_LEVEL: info
```

## secrets

A list of secret declarations. Each entry must have a `name` and a `required` flag.

```yaml
secrets:
  - name: SEARCH_API_KEY
    required: true
  - name: MEMORY_API_KEY
    required: false
```

The compiler warns when a required secret is not present in the execution environment used for compilation.

## policy

The `policy` block controls how strictly the compiler enforces capability preservation. It is optional and defaults to permissive mode.

```yaml
policy:
  mode: strict      # strict | warn | permissive (default: permissive)
  on_degrade: error  # error | warn | allow (default: allow)
```

- `strict` -- the compiler fails on any capability it cannot verify or preserve.
- `warn` -- the compiler emits a warning and may continue.
- `permissive` -- the compiler continues but still records the outcome in the compile report.

`on_degrade` controls behavior when a capability is partially mapped but not fully equivalent:
- `error` -- compilation fails.
- `warn` -- compilation continues with a warning.
- `allow` -- compilation continues silently.

## surfaces

The `surfaces` block declares external communication channels for the agent. The first standardized surface in v0.1 is Discord.

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

### Discord Fields

| Field | Description |
|-------|-------------|
| `bot_token_secret` | Env var name for the Discord bot token. Defaults to `DISCORD_BOT_TOKEN`. |
| `access.mode` | Access policy: `pairing`, `allowlist`, or `open`. |
| `access.users` | Allowed Discord user IDs. |
| `access.guilds` | Allowed Discord guild/server IDs. |
| `access.channels` | Allowed Discord channel IDs. |

### Access Rules

- If `access.mode` is omitted and any of `users`, `guilds`, or `channels` are present, the effective mode is `allowlist`.
- `users`, `guilds`, and `channels` are only valid with `allowlist`.
- `allowlist` must declare at least one of `users`, `guilds`, or `channels`.

### Runtime Support

Not all runtimes support all Discord access shapes:

- `openclaw` supports `pairing`, `allowlist`, and `open`.
- `picoclaw` supports `open` and user allowlists.
- `tinyclaw` supports `pairing` only (DM-oriented).

The compiler validates the declared surface against the selected runtime and fails early on unsupported combinations.

### Constraints

- Only agent manifests may declare `surfaces`. Team manifests must not.
- Subagents do not inherit parent `surfaces`.
- Surface auth secrets (like `DISCORD_BOT_TOKEN`) participate in the same auth profile and env validation path as model auth.

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

Subagents inherit the parent's runtime. They do not inherit docs, skills, MCP servers, env, or secrets -- each subagent is a self-contained project.

For execution, the parent's `execution` is deep-merged with the subagent's local `execution`: objects merge recursively, scalars replace, arrays replace wholesale.

## Environment Variable Substitution

String values in a manifest may contain `${VAR}` or `${VAR:-default}` references that are resolved at manifest load time before schema validation.

```yaml
execution:
  model:
    primary:
      provider: ${PROVIDER:-anthropic}
      name: ${MODEL:-claude-sonnet-4-5}

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

runtime: openclaw

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
  workspace:
    isolation: isolated
  sandbox:
    mode: workspace

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

mcp_servers:
  - name: web_search
    transport: streamable_http
    url: https://search.mcp.example.com/mcp
    auth:
      secret: SEARCH_API_KEY

surfaces:
  discord:
    access:
      users:
        - "987654321098765432"
    bot_token_secret: DISCORD_BOT_TOKEN

secrets:
  - name: SEARCH_API_KEY
    required: true

policy:
  mode: warn
  on_degrade: warn
```
