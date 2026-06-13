# Spawnfile Specification

**Version:** 0.1 (draft)
**Status:** Work in progress

---

## Conventions

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

A **conforming source project** is one that satisfies all MUST requirements in this document.
A **conforming compiler** is one that correctly processes conforming source projects and reports all MUST NOT violations.

---

## 0. Scope

The current v0.1 contract uses `spawnfile_version: "0.1"`. No `0.2` manifest version or compatibility mode is introduced here.

### 0.1 What Spawnfile Targets

Spawnfile is a canonical authoring format for **autonomous agent runtimes**: systems that host agents as long-lived services rather than tools invoked per task.

Spawnfile targets runtimes whose authoring model centers on a **markdown workspace**: a persistent directory of Markdown documents that define agent identity, behavior, and operating context, and that the agent can read and update during operation.

A runtime is **Spawnfile-compatible** when it satisfies all of these hard gates:

- It runs as a long-lived service or daemon.
- It uses a markdown workspace as a first-class agent surface.
- It exposes a declarative configuration surface that a compiler can emit.

### 0.2 Portable Surface

Spawnfile v0.1 defines a portable surface that adapters attempt to preserve across compatible runtimes. These are portability targets, not runtime-admission requirements:

- markdown document roles (`identity`, `soul`, `system`, `memory`, `heartbeat`, `extras`) declared under `workspace.docs` or `shared.workspace.docs`
- skills with `SKILL.md` declared under `workspace.skills` or `shared.workspace.skills`
- MCP server declarations
- runtime binding and execution intent
- workspace resources and environment inputs declared on agents or shared by teams
- team structure, team networks, and generated team-context artifacts
- optional runtime capabilities such as communication surfaces, memory backends, periodic tasks, and proactive behavior

If a runtime cannot preserve part of this surface exactly, the adapter reports `supported`, `degraded`, or `unsupported` according to compile policy.

### 0.3 Write-only Runtime Boundary

Spawnfile is a compiler/canonicalizer. It may write generated files, runtime-native config, env files, mounted credential stores, generated secrets, and explicit operator-triggered updates into spawned runtime environments.

Spawnfile MUST NOT read spawned runtimes, containers, runtime homes, or agent workspaces to discover identity, infer organization state, rewrite rosters, or maintain live coordination state. Runtime adapters MUST NOT observe a running runtime and feed discovered identities back into generated rosters as part of the v0.1 alpha contract.

`spawnfile status --live` is the narrow read-only diagnostic exception. It may read deployment managers, adapter-owned runtime health probes, and Moltnet metadata as specified in `STATUS.md`, but those observations are never source of truth and MUST NOT be written back into authored manifests, rosters, generated identity files, or team membership.

If an agent or runtime learns new facts after spawn, such as a Slack user ID, Discord account ID, or updated team document, those facts must become authored input through the organization's workflow: commit to the repository, update an authored Spawnfile, write to a declared state store, or ask an operator to persist the change. Spawnfile can then reflect those authored inputs on the next compile or run.

### 0.4 Non-Target Systems

Spawnfile does not target systems that are manually invoked per task, even if they use workspace conventions or Markdown control files. Coding assistants, chat CLIs, and one-shot agent shells may share files like `AGENTS.md`, but they are not the long-lived host runtimes that Spawnfile compiles for.

---

## 1. File Format

### 1.1 The Manifest

A Spawnfile manifest MUST be a file named exactly `Spawnfile` - no extension - located at the root of the source project directory.

The manifest MUST be valid YAML 1.2 and MUST be UTF-8 encoded with no BOM.

### 1.2 Top-level Required Fields

Every manifest MUST declare:

```yaml
spawnfile_version: "0.1"   # string, not number
kind: agent                # "agent" or "team"
name: my-agent             # non-empty string, no whitespace
```

### 1.3 Description

`description` is OPTIONAL. It is a short, single-line, human-readable string (one or two sentences) that summarizes what this agent or team does. If a multi-line YAML scalar is used, the compiler MUST normalize it by collapsing newlines into spaces and trimming trailing whitespace.

For agents, `description` is the primary signal used in team rosters — it tells teammates what this agent does. If `description` is omitted, the compiler SHOULD derive a description from the agent's `workspace.docs.identity` document by extracting the first non-empty paragraph, truncated to 200 characters. If no `workspace.docs.identity` is declared, the description is left empty.

For teams, `description` summarizes the team's collective purpose. If `description` is omitted, the compiler SHOULD derive a description from `shared.workspace.docs.identity` when that document is present; otherwise the description is left empty.

### 1.4 Path Resolution

All `ref` values and document file paths in a manifest are relative paths resolved from the manifest's directory.

- Paths MUST use forward slashes regardless of host OS.
- Paths MAY use `..` parent segments when the referenced file or directory intentionally lives next to, above, or outside a nested organization directory.
- Absolute paths MUST NOT be used.
- Symlinks MUST NOT be followed during compilation.
- A skill `ref` MUST point to a directory containing a `SKILL.md`.
- A member `ref` MUST point to a directory containing a `Spawnfile`.
- A document path MUST point to a UTF-8 Markdown file.

### 1.4 Manifest Graph

The compile graph is formed by following:

- team `members[*].ref`
- agent `subagents[*].ref`

Rules:

- The compile graph MUST be acyclic.
- A conforming compiler MUST detect cycles and fail compilation.
- Graph nodes are identified by their canonical manifest path.
- The same manifest path MAY be referenced more than once in a graph, but all such references MUST resolve to the same effective `runtime` and `execution`. Otherwise the compiler MUST fail.

---

## 2. Portable Surfaces

### 2.1 Document Roles

The `workspace.docs` block declares portable markdown surfaces for agents. The `shared.workspace.docs` block declares inherited markdown surfaces for teams. Compilers map these roles to target-specific workspace surfaces. Document contents are author text; this spec does not define their runtime behavior.

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
```

Built-in roles:

| Role | Description |
|------|-------------|
| `identity` | Stable self-description and agent identity |
| `soul` | Personality, voice, tone, and behavioral posture |
| `system` | Operating instructions and conventions |
| `memory` | Human-authored memory architecture or memory intent |
| `heartbeat` | Human-authored recurring or periodic task intent |
| `extras` | Arbitrary additional markdown documents keyed by author-defined names |

Rules:

- `workspace` is OPTIONAL for agents.
- `workspace.docs` is OPTIONAL.
- All `workspace.docs` fields are OPTIONAL.
- `shared.workspace` is OPTIONAL for teams.
- `shared.workspace.docs` is OPTIONAL.
- All `shared.workspace.docs` fields are OPTIONAL.
- Paths in `workspace.docs` and `shared.workspace.docs` MUST resolve to Markdown files from the declaring manifest's directory.
- A conforming compiler MUST treat document contents as opaque text and MUST NOT reinterpret them as structured schema.
- Team-level `shared.workspace.docs` describe the team manifest itself and MUST NOT automatically propagate to members except through the declared team-context artifacts.
- Top-level `docs` is not part of v0.1 and MUST NOT be used as a shorthand.

### 2.1.1 Workspace Resources

`workspace.resources` declares mounted resources for an agent workspace. `shared.workspace.resources` declares mounted resources for a team-shared workspace.

```yaml
workspace:
  resources:
    - id: project-repo
      kind: git
      url: https://github.com/example/project.git
      branch: main
      mount: ./repos/project
      mode: mutable
    - id: agent-scratch
      kind: volume
      name: agent-scratch-vol
      mount: ./scratch
      mode: mutable
shared:
  workspace:
    resources:
      - id: team-dropbox
        kind: volume
        mount: ./shared
        mode: mutable
        sharing: team
```

Rules:

- `workspace.resources` is OPTIONAL.
- `shared.workspace.resources` is OPTIONAL.
- Each resource MUST have:
  - `id`
  - `kind` (`git` or `volume`)
  - `mount`
  - `mode`
- `mode` MUST be `mutable` or `readonly`.
- `mount` is the path where the resource appears to the agent. It MUST be one of:
  - `./path` for a path inside the concrete agent's runtime workspace.
  - `${workspace}/path` as an explicit form of the same workspace-relative mount.
  - `/absolute/path` for an explicit advanced container path.
- `mount` MUST NOT point at the workspace root and MUST NOT contain `..` parent path segments.
- The compiler prepares resources in Spawnfile-managed backing storage and exposes them at `mount` through a symlink.
- `sharing` is OPTIONAL and defaults to `per_agent`.
- `sharing` MUST be `per_agent` or `team`.
- `sharing: per_agent` creates one backing resource per concrete runtime target.
- `sharing: team` is currently valid only for `volume` resources and creates one backing resource for the team where the resource is declared.
- `id` MUST be unique in the manifest.
- `id`, `kind`, `mount`, `mode`, `sharing`, and kind-specific source fields make up resource identity.
- `git` `url`, `branch`, `tag`, and `ref` values are normalized by trimming whitespace only.
- `volume` resources MAY declare an explicit `name` for backing state naming. When omitted, the compiler derives a stable name from project identity, resource `id`, and effective execution context.
- `git` resources MUST declare `url`.
- `git` resources MAY declare optional one-of selectors: `branch`, `tag`, or `ref`.
- At most one of `branch`, `tag`, or `ref` MAY be set on a single `git` resource.
- `git` resources MUST NOT declare `sharing: team`.
- `volume` resources MUST NOT declare `url`.
- In a concrete agent context, effective resources MUST either be unique by identity or normalize to identical declarations where IDs collide.
- In a concrete agent context, effective resource mounts MUST not overlap.
- Team resources declared under `shared.workspace.resources` are inherited by direct concrete members and selected representatives through nested teams.

### 2.2 Skills

Each entry in `workspace.skills` or `shared.workspace.skills` MUST have a `ref` pointing to a skill directory. A skill directory MUST contain a `SKILL.md` file.

`SKILL.md` MUST begin with a YAML frontmatter block declaring at minimum:

```yaml
---
name: web_search
description: "..."
---
```

A skill MAY declare `requires.mcp` - a list of logical MCP server names. Compilers MUST validate those names against the MCP server declarations visible in that manifest scope and MUST report an error if any required MCP server is not declared.

The exact contents of `SKILL.md` beyond required frontmatter are intentionally left to the author and target adapter.

### 2.3 MCP Servers

Each entry in `environment.mcp_servers` MUST have a unique `name` within its manifest scope. `name` values are logical identifiers, not runtime-specific instance ids.

`transport` MUST be one of: `stdio`, `streamable_http`, `sse`.

Transport requirements:

- `stdio` MUST declare `command`. It MAY declare `args` and `env`.
- `streamable_http` MUST declare `url`.
- `sse` MUST declare `url`.

Example:

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

Rules:

- `auth.secret` SHOULD be an environment variable name, not a literal credential value.
- Adapters MAY lower a logical MCP declaration into a runtime's native MCP config format.

### 2.4 Runtime Binding

For `kind: agent`, the `runtime` field declares which runtime adapter should compile the agent manifest. Team manifests MUST NOT declare `runtime`; each referenced agent declares its own runtime.

```yaml
runtime:
  name: openclaw
```

Rules:

- `runtime` MUST be either:
  - a non-empty string naming a registered runtime adapter
  - an object with required field `name`
- `runtime: openclaw` is shorthand for:

```yaml
runtime:
  name: openclaw
```

- If `runtime` is an object, `runtime.options` is OPTIONAL and MUST be a mapping.
- `runtime.options` is adapter-specific and outside the portable core.
- For `kind: agent`, `runtime` is REQUIRED. Subagents inherit their parent's runtime but MUST NOT declare a different one.
- For `kind: team`, `runtime` is INVALID. Teams compile by walking reachable members and using each agent member's own effective runtime.
- `spawnfile compile` MUST read runtime bindings from the manifest graph; the CLI does not select a runtime in v0.1.
- If compilation reaches an agent with no effective runtime binding, the compiler MUST fail.

Example long form:

```yaml
runtime:
  name: openclaw
  options:
    profile: default
```

### 2.5 Execution Intent

The `execution` block declares portable intent, not literal adapter config.

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

Rules:

- `execution.model.primary.provider` and `execution.model.primary.name` are REQUIRED if `execution.model` is present.
- `execution.model.primary` and each entry in `execution.model.fallback` are model targets.
- A model target MUST declare:
  - `provider`
  - `name`
- A model target MAY declare:
  - `auth`
  - `endpoint`
- `execution.model.fallback` is OPTIONAL and declares an ordered list of fallback model targets.
- Supported auth methods in v0.1 are: `api_key`, `claude-code`, `codex`, `none`.
- If a model target declares `auth`, it MUST declare `auth.method`.
- `auth.key` is OPTIONAL and MAY only be used with `auth.method: api_key`.
- For built-in providers, if inline `auth` is omitted, the effective auth method defaults to `api_key`.
- For `provider: local`, if inline `auth` is omitted, the effective auth method defaults to `none`.
- `provider: custom` MUST declare inline `auth.method` or inherit a legacy auth method from `execution.model.auth`.
- `provider: custom` and `provider: local` MUST declare `endpoint`.
- `endpoint` MUST NOT appear on built-in providers.
- `endpoint.compatibility` MUST be one of: `openai`, `anthropic`.
- `endpoint.base_url` MUST be a non-empty URL string.
- If a `custom` or `local` model target uses `auth.method: api_key`, it MUST declare `auth.key`.
- `execution.model.auth` is a legacy compatibility surface. It MAY declare:
  - `method` to apply one auth method to every declared provider
  - `methods` to apply auth methods per provider
- `execution.model.auth` MUST declare exactly one of `method` or `methods`.
- If `execution.model.auth.methods` is used, it MUST cover every declared provider in `primary` and `fallback`, and it MUST NOT declare providers that are not present in that model set.
- Canonical Spawnfiles SHOULD declare `auth` inline on each model target instead of relying on legacy `execution.model.auth`.
- `execution.sandbox.mode` MUST be one of: `workspace`, `sandboxed`, `unrestricted`.
- If `execution.sandbox` is omitted, the effective sandbox mode defaults to `workspace`.
- Compilers MUST treat these values as author intent and map them to runtime-native configuration.
- Compilers MUST reject runtime/auth combinations that the selected runtime adapter does not support.
- If exact semantics cannot be preserved, the compiler MUST report `degraded` or `unsupported` according to the compile policy.

### 2.6 Communication Surfaces

Spawnfile standardizes the following communication surfaces on agent manifests:

```yaml
surfaces:
  discord:
    identity:
      user_id: "987654321098765432"
    access:
      users:
        - "987654321098765432"
    bot_token_secret: DISCORD_BOT_TOKEN
  telegram:
    identity:
      user_id: "123456789"
      username: "research_bot"
    access:
      users:
        - "123456789"
      chats:
        - "-1001234567890"
    bot_token_secret: TELEGRAM_BOT_TOKEN
  whatsapp:
    identity:
      phone: "+15551234567"
    access:
      users:
        - "15551234567"
      groups:
        - "120363400000000000@g.us"
  slack:
    identity:
      user_id: "U1234567890"
    access:
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
      dms:
        enabled: true
        wake: never
  webhook:
    url: "https://my-service.example.com/callbacks"
    signing_secret: WEBHOOK_SECRET
```

Rules:

- `surfaces` is OPTIONAL.
- If `surfaces` is present, it MUST declare at least one surface.
- `surfaces.discord` is OPTIONAL.
- `surfaces.telegram` is OPTIONAL.
- `surfaces.whatsapp` is OPTIONAL.
- `surfaces.slack` is OPTIONAL.
- `surfaces.moltnet` is OPTIONAL.
- `surfaces.webhook` is OPTIONAL.
- `surfaces.discord.access` is OPTIONAL.
- `surfaces.telegram.access` is OPTIONAL.
- `surfaces.whatsapp.access` is OPTIONAL.
- `surfaces.slack.access` is OPTIONAL.
- `surfaces.discord.access.mode` MAY be `pairing`, `allowlist`, or `open`.
- `surfaces.telegram.access.mode` MAY be `pairing`, `allowlist`, or `open`.
- `surfaces.whatsapp.access.mode` MAY be `pairing`, `allowlist`, or `open`.
- `surfaces.slack.access.mode` MAY be `pairing`, `allowlist`, or `open`.
- `surfaces.discord.access.users`, `guilds`, and `channels` are OPTIONAL allowlist identifiers.
- `surfaces.telegram.access.users` and `chats` are OPTIONAL allowlist identifiers.
- `surfaces.whatsapp.access.users` and `groups` are OPTIONAL allowlist identifiers.
- `surfaces.slack.access.users` and `channels` are OPTIONAL allowlist identifiers.
- If `surfaces.discord.access.mode` is omitted and any of `users`, `guilds`, or `channels` are present, the effective mode is `allowlist`.
- If `surfaces.telegram.access.mode` is omitted and any of `users` or `chats` are present, the effective mode is `allowlist`.
- If `surfaces.whatsapp.access.mode` is omitted and any of `users` or `groups` are present, the effective mode is `allowlist`.
- If `surfaces.slack.access.mode` is omitted and any of `users` or `channels` are present, the effective mode is `allowlist`.
- If `surfaces.discord.access`, `surfaces.telegram.access`, `surfaces.whatsapp.access`, or `surfaces.slack.access` is omitted entirely, the effective behavior is runtime-defined and is not guaranteed to be portable across runtimes.
- `surfaces.discord.access.users`, `guilds`, and `channels` MUST only be used with `allowlist` access.
- `surfaces.telegram.access.users` and `chats` MUST only be used with `allowlist` access.
- `surfaces.whatsapp.access.users` and `groups` MUST only be used with `allowlist` access.
- `surfaces.slack.access.users` and `channels` MUST only be used with `allowlist` access.
- `surfaces.discord.access.mode: allowlist` MUST declare at least one of `users`, `guilds`, or `channels`.
- `surfaces.telegram.access.mode: allowlist` MUST declare at least one of `users` or `chats`.
- `surfaces.whatsapp.access.mode: allowlist` MUST declare at least one of `users` or `groups`.
- `surfaces.slack.access.mode: allowlist` MUST declare at least one of `users` or `channels`.
- `surfaces.discord.bot_token_secret` is OPTIONAL.
- `surfaces.telegram.bot_token_secret` is OPTIONAL.
- `surfaces.slack.bot_token_secret` is OPTIONAL.
- `surfaces.slack.app_token_secret` is OPTIONAL.
- If `surfaces.discord.bot_token_secret` is omitted, the effective secret name defaults to `DISCORD_BOT_TOKEN`.
- If `surfaces.telegram.bot_token_secret` is omitted, the effective secret name defaults to `TELEGRAM_BOT_TOKEN`.
- If `surfaces.slack.bot_token_secret` is omitted, the effective secret name defaults to `SLACK_BOT_TOKEN`.
- If `surfaces.slack.app_token_secret` is omitted, the effective secret name defaults to `SLACK_APP_TOKEN`.
- WhatsApp does not currently define a portable token-secret field; runtime-specific session or QR auth remains adapter-defined.
- `surfaces.discord.identity.user_id` is OPTIONAL. If present, it is a Discord user snowflake string advertised in generated rosters where this agent is visible.
- `surfaces.telegram.identity` is OPTIONAL and MUST declare `user_id`, `username`, or both. `user_id` MAY be numeric or numeric-string; `username` is the Telegram username without a leading `@`.
- `surfaces.whatsapp.identity.phone` is OPTIONAL and SHOULD be an E.164 phone number.
- `surfaces.slack.identity.user_id` is OPTIONAL. If present, it is the Slack user ID advertised in generated rosters where this agent is visible.
- Surface `identity` fields are opt-in roster metadata. They do not provision accounts, validate provider-side membership, or cause Spawnfile to read runtime state.
- `surfaces.moltnet` is a list of Moltnet attachments. Each attachment MUST declare `network` and at least one of `rooms` or `dms`.
- Moltnet room and DM `wake` policy MAY be `all`, `mentions`, `thread_only`, or `never`.
- Moltnet room and DM `reply` policy MAY be only `auto` or `never` in this alpha. `manual` is not part of the portable v0.1 contract.
- Moltnet attachments are valid only when the agent participates in a team context whose `team.networks[]` declares the named network and rooms.
- `surfaces.webhook.url` is REQUIRED when `surfaces.webhook` is present. It MUST be a valid URL.
- `surfaces.webhook.signing_secret` is OPTIONAL. It names the env var carrying the HMAC-SHA256 signing secret. When present, the runtime MUST sign webhook payloads.
- Webhook delivery is fire-and-forget: the runtime attempts delivery once with a timeout of 10 seconds. A non-2xx response or timeout means the event is lost. The runtime SHOULD log delivery failures.
- Webhook payloads use the same event envelope format as SSE events, delivered as `application/json` via HTTP POST.
- Declared surface auth names participate in the same run-time env validation path as other env-backed auth.
- Team manifests MUST NOT declare `surfaces`. Communication surfaces belong to concrete agent manifests.
- Subagents do not implicitly inherit parent `surfaces`.
- A conforming compiler MUST validate runtime support for declared surface access and fail early on unsupported runtime/surface combinations.
- A runtime MAY declare limits on how many independent interactive conversation scopes it can preserve at once.
- An interactive conversation scope is a runtime-visible inbound conversation boundary such as a chat surface, a Moltnet room, or a Moltnet DM.
- A conforming compiler MUST validate declared interactive conversation scopes against the selected runtime and fail early when the runtime cannot preserve independent context for the resulting shape.

Portable HTTP ingress is not part of the v0.1 alpha surface schema. Runtime-native HTTP APIs MAY remain available through runtime-specific options, but they are not portable Spawnfile surfaces and MUST NOT be emitted as roster addresses.

### 2.7 Environment Inputs

`environment` declares runtime and image inputs for an agent. `shared.environment` declares inherited runtime and image inputs for a team.

```yaml
environment:
  env:
    LOG_LEVEL: info
  secrets:
    - name: SEARCH_API_KEY
      required: true
  packages:
    - id: github-cli
      manager: apt
      name: gh

shared:
  environment:
    env:
      GIT_AUTHOR_NAME: Example Agents
    secrets:
      - name: PROJECT_GH_TOKEN
        required: true
    packages:
      - id: yt-dlp
        manager: pipx
        name: yt-dlp
```

Rules:

- `environment` is OPTIONAL.
- `shared.environment` is OPTIONAL.
- `environment.env` and `shared.environment.env` are OPTIONAL flat key-value maps of non-secret environment values. Values MUST be strings.
- `environment.secrets` and `shared.environment.secrets` are OPTIONAL lists. Each entry MUST have `name` and `required`.
- `environment.packages` and `shared.environment.packages` are OPTIONAL lists of declarative package inputs.
- `packages` are runtime/image environment inputs, not workspace resources.
- `package.id` values MUST be unique within one `environment.packages` list.
- `package.manager` is REQUIRED. Valid values are `apt`, `npm`, and `pipx`.
- `package.name` is REQUIRED. It is the manager-native package name.
- `package.version` is OPTIONAL. Version interpretation is manager-specific.
- `package.scope` is OPTIONAL and currently valid only for `manager: npm` with value `global`.
- `apt` packages lower into generated container images through `apt-get install`; `version` becomes `name=version`.
- `npm` packages lower into generated container images through global `npm install -g`; `version` becomes `name@version`.
- `pipx` packages lower into generated container images through `pipx install`; `version` becomes `name==version`.
- If an inherited and member-local package share the same `manager` and `name`, the member-local package wins. If multiple concrete agents are packed into the same generated container target and their effective package definitions conflict, the compiler MUST fail rather than selecting one silently.
- Compilers SHOULD warn when a secret is marked `required` but is not present in the execution environment used for compilation or deployment.

---

## 3. Agent Schema

### 3.1 Full Manifest

```yaml
spawnfile_version: "0.1"
kind: agent
name: analyst
description: "Research analyst that finds, evaluates, and synthesizes information"

workspace:
  docs:
    identity: IDENTITY.md
    soul: SOUL.md
    system: AGENTS.md
    memory: MEMORY.md
    heartbeat: HEARTBEAT.md
    extras:
      notes: docs/NOTES.md
  resources:
    - id: project-repo
      kind: git
      url: https://github.com/example/project.git
      branch: main
      mount: ./repos/project
      mode: mutable
  skills:
    - ref: ./skills/web_search
      requires:
        mcp:
          - web_search

runtime:
  name: openclaw
  options:
    profile: default

execution:
  model:
    primary:
      provider: anthropic
      name: claude-sonnet-4-5
      auth:
        method: api_key
    fallback:
      - provider: openai
        name: gpt-4o-mini
        auth:
          method: codex
  sandbox:
    mode: workspace

schedule:
  kind: cron
  cron: "0 9 * * *"
  timezone: UTC
  prompt: "Read heartbeat context and complete one bounded research iteration."

surfaces:
  discord:
    access:
      users:
        - "987654321098765432"
    bot_token_secret: DISCORD_BOT_TOKEN
  slack:
    access:
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

environment:
  env:
    LOG_LEVEL: info
  mcp_servers:
    - name: web_search
      transport: streamable_http
      url: https://search.mcp.example.com/mcp
      auth:
        secret: SEARCH_API_KEY
    - name: memory_store
      transport: streamable_http
      url: https://memory.mcp.example.com/mcp
      auth:
        secret: MEMORY_API_KEY
  secrets:
    - name: SEARCH_API_KEY
      required: true
    - name: MEMORY_API_KEY
      required: false
  packages:
    - id: playwright
      manager: npm
      name: playwright
      version: "1.57.0"
      scope: global

policy:
  mode: strict
  on_degrade: error
```

Declared secrets are runtime inputs, not literal secret values. `spawnfile auth sync --env-file <file>` MUST collect values for declared required secrets from the process environment or the provided env file and MUST fail when a required value is unavailable. Optional declared secrets SHOULD be copied into the selected auth profile when a value is available, and ignored when absent.

`spawnfile run --env-file <file>` MUST inject the provided env file values into the generated Docker run environment for that invocation. When an auth profile and run env file both define the same variable, the run env file value wins. A value from the process environment wins over both when that variable is part of the generated run environment.

### 3.2 Validation Scope

For an agent manifest, skill `requires.mcp` names MUST be validated against that agent's visible MCP server list.

All blocks other than the top-level required fields are OPTIONAL unless otherwise stated by their own rules.

### 3.3 Agent Schedule

`schedule` is OPTIONAL and valid only on agent manifests. It declares agent-owned wake intent; deployment profiles and renderers may decide how to materialize it for a target environment.

Runtimes that do not expose native wake scheduling must lower schedules through a Spawnfile-owned runner process only when:

- the adapter explicitly exposes a wake contract, and
- the command is started via `spawnfile up`.

If neither native scheduling nor an adapter wake contract exists, `agent.schedule` reports `degraded`.

Cron example:

```yaml
schedule:
  kind: cron
  cron: "0 9 * * *"
  timezone: UTC
  prompt: "Read heartbeat context and complete one bounded research iteration."
```

Interval example:

```yaml
schedule:
  kind: every
  every: 2h
  prompt: "Read heartbeat context and complete one bounded maintenance step."
```

Disabled example:

```yaml
schedule:
  kind: disabled
```

Rules:

- `kind` MUST be one of `cron`, `every`, or `disabled`.
- `cron` schedules MUST declare a non-empty `cron` expression.
- `every` schedules MUST declare a non-empty `every` interval.
- `every` intervals use explicit duration strings such as `15m`, `2h`, or `1d`.
- `timezone` defaults to `UTC` when omitted.
- `cron` and `every` schedules MAY declare `timezone` and `prompt`.
- `disabled` schedules MUST NOT declare `cron`, `every`, `timezone`, or `prompt` fields.
- A `disabled` schedule MUST not emit a spawn or wake registration.
- Team manifests MUST NOT declare `schedule`.

### 3.4 Subagents

`subagents` is OPTIONAL. It declares helper agents owned by the parent agent.

Example:

```yaml
subagents:
  - id: researcher
    ref: ./subagents/researcher
  - id: critic
    ref: ./subagents/critic
```

Rules:

- Each subagent MUST have a unique `id` within the parent agent.
- Each `ref` MUST point to an agent source project.
- A subagent is not a team member. It is an internal helper or delegate of the parent agent.
- A subagent inherits the parent agent's effective `runtime` unless an adapter explicitly supports another lowering strategy.
- If a target runtime has no native subagent concept, the compiler MAY lower subagents into delegate agents, runtime-native sessions, or spawned workers, but it MUST report `degraded` if semantics are not equivalent.

### 3.5 Effective Subagent Resolution

For a subagent reference, the effective configuration is resolved as follows:

- Effective `runtime` is the parent agent's effective `runtime`.
- If the referenced subagent manifest declares `runtime`, it MUST match the parent agent's effective `runtime`. Otherwise the compiler MUST fail.
- Effective `execution` is the parent agent's `execution` deep-merged with the subagent's local `execution`, if any.
- For `execution` deep merge:
  - object fields are merged recursively
  - scalar fields replace parent values
  - arrays replace parent values wholesale
- Subagents do not implicitly inherit the parent's `workspace`, `environment`, or `surfaces` declarations. A subagent MAY declare any of these surfaces in its own Spawnfile manifest — they are simply not copied from the parent. Each subagent is a self-contained agent project that happens to be owned by a parent.

---

## 4. Team Schema

### 4.1 What A Team Is

A Spawnfile team is an organizational structure that defines:

- who is in the team (`members`)
- what they share (`shared.workspace`, `shared.environment`, and any declared tool servers)
- how the team is organized (`mode`, `lead`, `external`)
- who the team is as a collective (`shared.workspace.docs`)
- which provider-backed team networks exist (`networks`)
- which context artifacts members receive (`TEAM.md`, rosters, team cards, and context indexes)

The distinction between `agent` and `team` is deliberate:

- `agent` + `subagents` = one authored agent with internal helpers. Subagent orchestration is the runtime's concern.
- `team` = several first-class authored agents that belong together as an organizational unit.

Teams are:

- canonical author intent
- degradation-aware
- potentially multi-runtime
- coordination-aware through declared agent surfaces and declared team networks

Direct protocol surfaces belong to agents, not teams. A team does not cause Spawnfile to inject a custom message router, MCP tool, proxy process, team-secret route, or other runtime coordination primitive. How agents reach each other is a function of the surfaces they share and the addresses the manifest makes knowable at compile time.

Spawnfile does not assume that every runtime has a native team config format, nested teams, shared team memory, or durable team lifecycle APIs.

Adapters MAY lower a Spawnfile team into a native team object, a flat leader/member config, provider-backed rooms, generated context files, or another target-native surface. If a target cannot preserve the declared structure, the compiler MUST report `degraded` or `unsupported`.

Coordination rules beyond what the manifest declares (handoff protocols, escalation paths, conflict resolution) belong in the team's `shared.workspace.docs.system` document, where LLM agents can read and follow them as natural language instructions.

See `research/RUNTIME-NOTES.md` for per-runtime team lowering research.

### 4.2 Full Manifest

```yaml
spawnfile_version: "0.1"
kind: team
name: research-cell
description: "Research team that finds, analyzes, and writes up findings"

mode: hierarchical
lead: orchestrator

shared:
  workspace:
    docs:
      system: TEAM.md
    resources:
      - id: project-repo
        kind: git
        url: https://github.com/example/project.git
        branch: main
        mount: ./repos/project
        mode: mutable
      - id: agent-scratch
        kind: volume
        mount: ./scratch
        mode: mutable
      - id: team-dropbox
        kind: volume
        mount: ./shared
        mode: mutable
        sharing: team
    skills:
      - ref: ./shared/skills/web_search
  environment:
    env:
      GIT_AUTHOR_NAME: Example Agents
    mcp_servers:
      - name: web_search
        transport: streamable_http
        url: https://search.mcp.example.com/mcp
        auth:
          secret: SEARCH_API_KEY
    secrets:
      - name: SEARCH_API_KEY
        required: true
    packages:
      - id: github-cli
        manager: apt
        name: gh
      - id: yt-dlp
        manager: pipx
        name: yt-dlp

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

policy:
  mode: warn
  on_degrade: warn
```

### 4.3 Members

Each member MUST have a unique `id` within the team and a `ref` pointing to either an agent source project or a team source project.

The member `id` is the **slot name** — the role this agent fills in this team. The `ref` is who fills that slot. The same agent project MAY fill different slots in different teams.

Each referenced agent MUST declare its own `runtime` in its Spawnfile. Teams do not override or assign runtimes to members.

Direct members of the same team MAY be on the same runtime or on different runtimes, depending on what each member declares.

The same agent source project MAY be referenced by multiple team manifests. Each occurrence is a separate logical direct membership keyed by the agent source, team source, and member slot id. A concrete reusable agent that belongs to several teams MUST receive separate team-context artifacts for each direct membership; compilers MUST NOT merge those roles into one synthetic team document or roster.

A nested team member is a black box to the outer team:

- The outer team targets the nested team as a unit by its `member.id`, not its internal members.
- The outer team MUST NOT address arbitrary inner members of a nested team directly.
- The inner team's own structure is compiled separately.
- Parent-team communication with a nested team crosses the boundary through the child team's resolved representatives.
- Non-representative inner members MUST NOT receive parent team context just because their team is nested.
- If a target lacks nested team support, the compiler MAY flatten or re-express the nested team boundary, but it MUST report `degraded`.

### 4.4 Shared Workspace And Environment

`shared.workspace.docs`, `shared.workspace.resources`, `shared.workspace.skills`, `shared.environment.env`, `shared.environment.secrets`, `shared.environment.packages`, and `shared.environment.mcp_servers` are OPTIONAL and are inherited by all direct members of the team.

Inheritance rules:

- Members extend the shared surface.
- Members MUST NOT remove inherited items.
- On MCP name conflict, the member-local declaration MUST win.
- On env, secret, package, or resource name conflict, the member-local declaration MUST win.
- The outer team's shared surface MUST NOT automatically propagate through a nested team boundary into that nested team's own members.

For validation of a shared skill's `requires.mcp`, the visible MCP scope is `shared.environment.mcp_servers`.

For validation of a direct member's skill `requires.mcp`, the visible MCP scope is the union of inherited shared MCP servers and member-local MCP servers, with member-local names taking precedence.

### 4.5 Mode, Lead, and External

#### `mode`

REQUIRED for `kind: team`. Defines the team's organizational and coordination topology.

| Mode | Description |
|------|-------------|
| `hierarchical` | Leader-led team. One member slot is the designated lead who delegates and coordinates. |
| `swarm` | Flat peer team. All members are peers. |

#### `lead`

The `id` of the member slot that leads the team. REQUIRED when `mode` is `hierarchical`. MUST NOT be present when `mode` is `swarm`.

The leader is the default authority, escalation point, and — unless `external` overrides it — the default voice of the team to the outside world.

The lead slot MAY reference either an agent or a nested team. If it references a nested team, the nested team's representative interface resolves to one or more concrete lead delegates. Runtime-native fields that require a single leader MUST NOT silently pick an arbitrary delegate. They MAY lower a single resolved delegate exactly; if multiple delegates resolve, they MUST report degraded or unsupported according to policy while preserving the multi-delegate context in rosters and team networks.

Adapters SHOULD map `lead` to native leader or default-agent concepts when they exist.

#### `external`

OPTIONAL. A list of direct member slot `id` values that represent the team in parent-team and organization-boundary contexts.

Members not listed in `external` are not advertised as this team's representative interface. They remain valid agent manifests with their own declared surfaces; team membership does not suppress or delete those surfaces.

Defaults:

- `hierarchical` mode: defaults to `[lead]` if not specified
- `swarm` mode: defaults to all members if not specified

Examples:

```yaml
# Leader-led, only leader represents the team upward (default)
mode: hierarchical
lead: orchestrator

# Leader-led, but researcher is also a representative
mode: hierarchical
lead: orchestrator
external: [orchestrator, researcher]

# Swarm, all peers represent the team by default
mode: swarm

# Swarm, but only two are representatives
mode: swarm
external: [monitor-a, monitor-b]
```

`external` is representative intent, not router/default-agent intent. It does not create routes or forwarding behavior. A child team selected in a parent context resolves recursively:

1. If `external` is declared, select those direct member slots.
2. Else if `mode: hierarchical`, select `[lead]`.
3. Else if `mode: swarm`, select all direct member slots.
4. For each selected slot, include the agent directly or, if the slot is a nested team, resolve that child team's representative interface using the same rules.

Validation rules:

- Every `external` entry MUST name a direct member slot of that team.
- A `lead` value MUST name a direct member slot of that team.
- Any team selected as a parent-room member, selected by another team's `external`, or selected as another team's `lead` MUST resolve to at least one concrete representative agent.
- Representative resolution MUST NOT include arbitrary descendants. A descendant is included only when every boundary on the path selects it through `external`, `lead`, or swarm fallback.
- The compiler SHOULD warn when a nested swarm team is exposed without explicit `external`, because swarm fallback can expose many representatives.
- If a team used as `lead` resolves to multiple concrete representatives, Spawnfile treats all of them as lead delegates. The compiler MUST NOT silently pick the first representative.

### 4.6 Team Networks

`team.networks[]` declares provider-backed organizational communication topology. A network is a shared team-level topology that Spawnfile can compile, provision, bind, or validate. It is not an IP network abstraction and it is not an agent-local surface.

`surfaces` are agent-level communication capabilities. `team.networks[]` is team-level organization topology. Agents attach to a declared network through their own surface declarations, and the team network defines shared rooms/channels in the team context.

Moltnet is the first provider for this contract:

```yaml
networks:
  - id: local_lab
    provider: moltnet
    server:
      mode: managed
      url: http://127.0.0.1:8787
      listen:
        bind: 127.0.0.1
        port: 8787
      human_ingress: true
      direct_messages: false
      debug_events: false
      console:
        analytics:
          provider: google
          measurement_id: G-XXXXXXXXXX
      trust_forwarded_proto: false
      allowed_origins:
        - http://localhost:8787
      store:
        kind: sqlite
        path: /var/lib/spawnfile/moltnet/networks/local_lab/moltnet.sqlite
        persistence:
          mode: durable
      auth:
        mode: open
        public_read: true
        agent_registration: open
    rooms:
      - id: org-council
        name: Org Council
        visibility: public
        write_policy: members
        members: [coordinator, research-team]
```

Rules:

- `team.networks` is OPTIONAL.
- In v0.1, `provider` MUST be `moltnet`.
- Each network `id` MUST be unique within the team.
- Each room `id` MUST be unique within the network.
- `server` is REQUIRED. It MUST declare `mode`.
- In v0.1, `server.mode` MUST be `managed` or `external`.
- `server.mode: managed` means Spawnfile may provision and start the Moltnet server.
- `server.mode: external` means Spawnfile emits only client/node config to connect to a remote URL.
- `server.mode: managed` MUST include `listen`, `store`, and `auth`.
- `server.mode: managed` may include `url` (explicit). If omitted, it derives from `listen`.
- `server.listen.bind` is required for managed servers and must be a non-empty host string.
- `server.listen.port` is required for managed servers and must be an integer from 1 to 65535.
- Bracketed IPv6 literals in `server.listen.bind` are invalid in v0.1; use raw literals such as `::1` or `::`.
- In managed mode, raw IPv6 bind values are accepted and must be bracketed when rendered into `url`.
- `server.url` and `server.listen` may use IPv4, hostnames, or raw IPv6 literals.
- `server.url` must be a valid URL.
- `server.url` is required for `server.mode: external`.
- `server.mode: external` MUST NOT include `listen`, `store`, `server.auth.tokens`, `server.pairings`, `human_ingress`, `direct_messages`, `debug_events`, `console`, `trust_forwarded_proto`, or `allowed_origins`.
- `server.auth.mode` MUST be one of `none`, `bearer`, or `open`.
- `server.auth.public_read` is OPTIONAL and defaults to the Moltnet server default. When `true`, anonymous callers may read only rooms whose `visibility` allows public reads.
- `server.auth.agent_registration` is OPTIONAL and MUST be one of `disabled`, `token`, or `open` when present. It controls generated agent-token self-registration and does not grant room write access by itself.
- For `server.auth.mode: none`, `server.auth` MUST NOT include `tokens` or `client`.
- `server.mode: managed` with `server.auth.mode: bearer` requires `server.auth.tokens`.
- `server.mode: external` with `server.auth.mode: bearer` requires `server.auth.client` with `token_env` or `token_path`, unless `server.auth.agent_registration: open` is declared and the generated node will self-register for an agent token.
- For `server.auth.mode: open`, `server.auth.tokens` MAY be present but `server.auth.client` is optional.
- For `server.auth.mode: open`, `server.auth.agent_registration` MUST be omitted or `open`; `disabled` and `token` are invalid because open mode is already a self-claiming registration mode.
- `server.auth.client` MUST include exactly one token source field: `token_id`, `token_env`, or `token_path` when present.
- `server.auth.client` for `managed` servers must use `token_id` and reference one declared token.
- `server.auth.client` for `external` servers may use `token_env` or `token_path`.
- `server.auth.client.static_token` is valid only for `server.auth.mode: open` and only when a client token source is declared.
- `server.auth.client` for open mode must set `static_token: true`; open mode without a client emits per-agent generated token files.
- For managed bearer mode, the managed `server.auth.client` token source must resolve a token with `attach` and `write` scope.
- `server.auth.mode: none` rejects all token sources.
- `server.pairings` is valid only for `server.mode: managed`.
- Managed `server.pairings` entries use `id` and MAY include `remote_network_id`, `remote_network_name`, `remote_base_url`, and `token_secret`.
- `server.pairings.id` MUST be unique within one managed server block.
- `server.store` MUST be present for `server.mode: managed`.
- `server.store.kind` MUST be `sqlite`, `json`, `postgres`, or `memory`.
- `server.store.kind: sqlite` and `server.store.kind: json` MAY omit `path`; omitted paths default under `/var/lib/spawnfile/moltnet/networks/<network-id>/`.
- `server.store.kind: sqlite` lowers to `moltnet.sqlite` by default and does not allow `dsn_secret`.
- `server.store.kind: json` lowers to `state.json` by default and does not allow `dsn_secret`.
- `server.store.kind: postgres` requires `server.store.dsn_secret`.
- `server.store.kind: memory` must not include `path` or `dsn_secret`.
- `server.store.persistence` is valid only for `sqlite` and `json`.
- `server.store.persistence.mode` MUST be `durable` or `ephemeral`.
- If `server.store.persistence` is omitted for `sqlite` or `json`, the compiler treats it as `durable`.
- `server.store.persistence.mode: durable` emits a persistent runtime mount for the store directory.
- `server.store.persistence.mode: ephemeral` emits no persistent runtime mount.
- `server.store.persistence.name` MAY name the runtime volume for durable stores.
- `server.store.persistence.mount` MAY override the durable container mount directory; when both `path` and `mount` are declared, `path` MUST be inside `mount`.
- Open auth without `server.auth.client` emits per-agent generated token files under private agent runtime state and those token directories are durable runtime mounts.
- `server.direct_messages: false` means any `surfaces.moltnet[].dms` for that network is a validation error.
- `server.debug_events: true` is valid only for managed Moltnet servers and lowers to Moltnet lifecycle diagnostics. It can expose disconnect reasons and bridge/runtime errors through events, so it is intended for operational debugging, not normal public network defaults.
- `server.console.analytics` is valid only for managed Moltnet servers and configures the hosted `/console/` page. In v0.1 the only supported provider is `google`, with a GA4 `measurement_id` such as `G-XXXXXXXXXX`.
- A room `members` list MAY name direct agent member IDs or direct child-team member IDs.
- A room `visibility` is OPTIONAL and MUST be `public` or `private` when present. Public visibility only becomes anonymous-readable when `server.auth.public_read: true`.
- A room `write_policy` is OPTIONAL and MUST be `members`, `registered_agents`, or `operators` when present. Generated agent tokens are identity tokens; they do not bypass `members` or `operators` policies.
- Direct child-team IDs in a parent room expand to the child team's concrete representatives for that parent context.
- Parent networks do not generally propagate through nested team boundaries. Only explicit parent-room representative attachments propagate, and only to selected representatives.
- Moltnet member IDs are the direct agent member slot IDs from the team where each concrete agent is a direct member. They MUST be unique across the full reachable team nesting used by the compile graph.
- If two direct agent member slots anywhere in the reachable nested team graph would compile to the same Moltnet `member_id`, compilation MUST fail with a validation error naming the colliding team paths and member slots.
- The same Moltnet network id MAY be reused by different teams. If the same concrete representative sees multiple attachments with the same `(network_id, member_id)`, the compiler MUST merge compatible room memberships into one client/bridge attachment. Incompatible duplicate attachments MUST fail compilation.
- Moltnet room and DM `reply` policy is limited to `auto` and `never` in this alpha contract.

### 4.7 Team Docs And Context Artifacts

The team's `shared.workspace.docs.system` document (typically `TEAM.md`) describes who the team is as a collective — purpose, culture, identity. It is also the place for coordination rules that go beyond what the manifest captures:

- Handoff protocols between members
- Escalation procedures
- Decision-making norms
- Quality standards

The team doc SHOULD reference member slot `id` values explicitly so agents can identify their role. Compilers MAY lint for drift between member IDs and the team doc content.

The team doc stays local to the team boundary. When compiled into member workspaces, it is emitted as a literal generated artifact rather than passed through the normal runtime document-role mapping. The compiler MUST NOT rename a team `shared.workspace.docs.system: TEAM.md` through `ROLE_FILE_NAMES` in a way that clobbers the member agent's own `AGENTS.md`.

Rules:

- Every direct membership gets a namespaced team document at `.spawnfile/team-contexts/<team-context-key>/TEAM.md`.
- Every direct membership gets a context-scoped roster at `.spawnfile/rosters/<team-context-key>.yaml`.
- If the compiled agent has exactly one direct team membership, the compiler MUST also emit convenience aliases at workspace root `TEAM.md` and `.spawnfile/roster.yaml`.
- If the compiled agent has multiple direct team memberships, the compiler MUST NOT emit root `TEAM.md` or root `.spawnfile/roster.yaml` as canonical context, because those paths are ambiguous.
- A concrete representative selected into a parent context also gets the parent team's `TEAM.md`, namespaced under `.spawnfile/team-contexts/<team-context-key>/TEAM.md`.
- Non-representative leaf agents do not receive ancestor `TEAM.md` files.
- The compiler MUST NOT merge multiple `TEAM.md` files. Every team context remains inspectable as its own document.
- `<team-context-key>` is a compiler-stable, path-safe key derived from the full context identity tuple, not only from team id or team name.
- The compiler MUST emit `.spawnfile/team-contexts.yaml` as the machine-readable context index and `.spawnfile/team-contexts.md` as the human/LLM-readable orientation.
- Compiler post-processing MUST place or point to `.spawnfile/team-contexts.md` through the compiled runtime's system-instruction surface. Adjacent files alone do not satisfy discoverability when the runtime has a system-instruction surface.

Parent rosters may reference team cards at `.spawnfile/team-cards/<team-context-key>/<parent-member-slot-id>.md`. A team card is a public description of a nested team in the parent context. It may include the child team's name, description, optional `shared.workspace.docs.identity`, and resolved representatives. It MUST NOT include the child team's `TEAM.md`, internal roster, non-representative members, or descendants not reached by the representative chain.

Team manifests MUST NOT declare `execution`. Model, sandbox, and workspace intent apply to agents and subagents, not to teams as organizational nodes.
Team manifests MUST NOT declare `surfaces`. Communication surfaces belong to concrete agent manifests.
Team manifests MUST NOT declare `auth`. Team auth lowering is now driven by `networks[].server`.

### 4.8 Team Roster

When compiling a team, the compiler MUST generate context-scoped rosters for direct memberships and selected representative parent contexts. A roster is a structured document that tells an agent about its visible team context: who else is visible, what they do, how the team is organized, and which derivable addresses are available for that context.

Canonical rosters live under `.spawnfile/rosters/*.yaml`. The root `.spawnfile/roster.yaml` path is a single-direct-membership convenience alias only when unambiguous. Rosters are not injected through the runtime document-role pipeline.

Roster v2 shape:

```yaml
self: sheldon
team: physics-lab
context_kind: direct
mode: hierarchical
lead: sheldon
members:
  leonard:
    role: member
    description: "Experimental physicist."
    surfaces: [moltnet]
    addresses:
      moltnet:
        local_lab:
          fqid: "molt://local_lab/agents/leonard"
          rooms: [apartment-4a]
  howard:
    role: member
    description: "Engineer."
    surfaces: [slack, moltnet]
    addresses:
      slack:
        user_id: "U7654321"
      moltnet:
        local_lab:
          fqid: "molt://local_lab/agents/howard"
          rooms: [apartment-4a]
  alpha-pod:
    role: team
    description: "Sub-team for ops."
    card:
      summary: "Ops sub-team. Contact for deployment and incident response."
      path: ".spawnfile/team-cards/physics-lab/alpha-pod.md"
    representatives:
      amy:
        description: "Primary ops representative."
        surfaces: [moltnet]
        addresses:
          moltnet:
            local_lab:
              fqid: "molt://local_lab/agents/amy"
              rooms: [org-council]
    surfaces: []
    addresses: {}
```

Rules:

- `self` is always the concrete reader and is excluded from `members`.
- In `hierarchical` mode, a non-lead reader sees only the lead slot. The lead reader sees all other members.
- If a hierarchical `lead` is a nested team that resolves to multiple concrete representatives, each lead delegate receives the parent roster view that the lead slot is entitled to.
- In `swarm` mode, each reader sees all other visible members.
- `lead` is the direct member slot id from the team manifest. If that slot is a nested team, the nested team entry uses `role: team` and `is_lead: true`; concrete delegates under `representatives` use `delegate_role: lead`.
- Member descriptions come from each agent's `description` field. If an agent has no `description`, the compiler SHOULD derive one from `workspace.docs.identity`. The compiler SHOULD warn if no description can be derived.
- Roster entries carry derivable per-surface `addresses`, not routed endpoints.
- Moltnet FQIDs are derivable and are emitted when visible in the roster context.
- Slack, Discord, Telegram, and WhatsApp addresses are emitted only when the corresponding `surfaces.<name>.identity` field is declared by the visible agent.
- If an agent declares a surface without identity, the roster MAY list the surface in `surfaces` while omitting an address. Teammates then rely on the provider's own discovery mechanisms, such as mentions, shared channel membership, or replies.
- Portable HTTP addresses are not part of roster v2.
- No roster `auth` block exists in this alpha.
- Nested team entries remain black boxes. A parent roster may show a child team, a team card, and selected representatives, but it MUST NOT expose the child team's full internal roster.

The compiler MUST build a coordination graph for each emitted team-context roster with more than one visible concrete participant. Nodes are visible concrete participants. Edges are shared declared coordination surfaces:

- a shared agent communication surface, such as Slack, Discord, Telegram, or WhatsApp, when both participants declare the same surface key in that team context
- a team network surface, such as a Moltnet room produced from `team.networks[]`, when both participants are attached to the same declared room after representative expansion

For non-network agent surfaces, this is a declared-presence edge only. The compiler does not validate provider-side Slack, Discord, Telegram, or WhatsApp workspace membership, channel membership, or actual discoverability.

The compiler MUST warn, not fail, when any visible concrete participant has no edge to another visible participant. It MUST also warn when the whole reachable cross-member coordination graph has no edges. These warnings belong in the compile report.

### 4.9 Team Lowering Contract

For team manifests, a conforming compiler MUST preserve the following author intent whenever the target allows it:

- which members belong to the team (slot IDs)
- the team mode and lead
- which members form the representative interface
- which workspace and environment inputs are shared versus member-local
- declared team networks and provider-backed rooms
- context-scoped team docs, rosters, context indexes, and team cards

A compiler MAY change the mechanical implementation used by the target runtime as long as the declared intent is preserved or the loss is reported as `degraded` or `unsupported`.

When `spawnfile compile` is run from a team root, the compiler MUST walk the reachable member graph and compile each agent member using that member's declared runtime. The compiler MUST also generate context artifacts for direct members and selected representatives.

If a team spans multiple runtimes, the compiler MAY emit multiple runtime-specific outputs as part of the same compile run.

Compilers MUST report capability outcomes for at least:

- `team.members`
- `team.mode`
- `team.lead`
- `team.external`
- `team.shared`
- `team.shared.workspace`
- `team.shared.environment`
- `team.nested`
- `team.roster`
- `team.context_orientation`
- `team.representatives`
- `team.networks`
- `team.networks.<provider>`
- `team.networks.<provider>.<network-id-key>`

Agent-declared surface identities report on the agent node with:

- `surfaces.<name>.identity`

Dynamic capability key segments MUST be report-key safe before joining with `.`. Use the raw segment when it matches `[A-Za-z0-9_-]+`; otherwise percent-encode the segment.

Compiler-owned capability outcomes for team context, representatives, and team networks MUST be attached before policy enforcement runs.

---

## 5. Compilation

### 5.1 Manifest-Driven Compilation

Compilation is driven by manifest state, not by a required target-selection flag.

Rules:

- Running `spawnfile compile` on an agent manifest compiles that agent to its effective `runtime`.
- Running `spawnfile compile` on a team manifest compiles each reachable member using that member's declared runtime.
- v0.1 does not require CLI selectors such as `--runtime` or `--target`.
- If the compiler cannot resolve a required runtime binding from the manifest graph, it MUST fail.

### 5.2 Adapter Contract

For a runtime to be a valid Spawnfile target in v0.1, its adapter MUST be able to do all of the following:

- place or inject declared docs into runtime-native surfaces, or report degradation
- install or expose declared workspace skills, or report degradation
- lower declarative environment inputs, including packages, or report degradation
- configure declared MCP servers, or report degradation
- map execution model intent into runtime-native model selection, or report degradation
- map execution sandbox intent into runtime-native execution policy, or report degradation
- map agent schedules into scheduler-capable runtimes or report `degraded` where lowering is partial
- for team manifests, lower member, representative, team-context, and team-network intent, or report `unsupported`

### 5.3 Compile Report

A conforming compiler MUST emit a machine-readable report for every compile run.

At minimum, the report MUST include:

- root manifest path
- one entry per compiled graph node
- each node's resolved `kind`
- each node's effective `runtime`
- each node's output directory
- capability outcomes
- diagnostics emitted during compilation

The exact on-disk filename and serialization format are implementation-defined in this spec, but a compiler SHOULD emit JSON by default.

---

## 6. Policy

Not every runtime supports every feature. When you compile an agent to a target runtime, some capabilities may be fully preserved, partially mapped, or entirely unsupported. The `policy` block tells the compiler how strictly to enforce capability preservation.

### 6.1 Why Policy Exists

Consider: you declare an agent with MCP servers and compile it to a runtime that has no MCP surface. The compiler can detect this gap — but should it fail the build, warn you, or quietly continue? Different projects need different answers. A production deployment may want strict enforcement. A prototype may want to compile whatever it can and move on.

### 6.2 Policy Declaration

`policy` is OPTIONAL. When omitted, the compiler defaults to `warn` mode with `on_degrade: warn` — compilation continues, but degraded or unsupported capability outcomes are surfaced as warnings in the compile report.

```yaml
policy:
  mode: strict      # strict | warn | permissive (default: warn)
  on_degrade: error # error | warn | allow (default: warn)
```

`mode` controls how the compiler handles uncertainty or missing fidelity:

- `strict` — the compiler MUST fail on any capability it cannot verify or preserve
- `warn` — the compiler MUST emit a warning and MAY continue
- `permissive` — the compiler MAY continue, but it MUST still record the capability outcome in the compile report

`on_degrade` controls behavior when the compiler determines a capability is `degraded` (partially mapped but not fully equivalent):

- `error` — compilation MUST fail
- `warn` — compilation continues with a warning
- `allow` — compilation continues silently

Unsupported capabilities are always at least warnings, and in `strict` mode they MUST fail compilation.

### 6.3 Capability Outcomes

For every declared capability the compiler MUST report one of:

| Outcome | Meaning |
|---------|---------|
| `supported` | Fully preserved in the target with equivalent intent |
| `degraded` | Partially mapped; runtime behavior may differ from declared intent |
| `unsupported` | Cannot be expressed in the target |

At minimum, compilers MUST report outcomes for declared docs, workspace skills, MCP servers, execution model intent, execution sandbox intent, schedules, workspace resources, environment inputs, declared surfaces, and team context/network intent.

### 6.4 How It Works In Practice

Given this manifest:

```yaml
runtime:
  name: openclaw

environment:
  mcp_servers:
    - name: web_search
      transport: streamable_http
      url: https://search.example.com/mcp

policy:
  mode: strict
  on_degrade: error
```

OpenClaw MCP currently goes through the mcporter bridge, so the adapter reports `mcp.web_search` as `degraded`. Because `on_degrade` is `error`, the compiler fails the build and tells you exactly which capability could not be preserved.

Change `on_degrade` to `warn` and the build succeeds — but the compile report still records the degradation so you know what was lost.

---

## 7. Metadata

A manifest MAY declare optional metadata fields for project identity and publication:

```yaml
spawnfile_version: "0.1"
kind: agent
name: analyst
description: "Research analyst agent"
author: noopolis
license: MIT
repository: https://github.com/noopolis/analyst-agent
```

Rules:

- `description`, `author`, `license`, and `repository` are all OPTIONAL.
- Values MUST be strings.
- These fields are informational. The compiler MUST pass them through to the compile report but MUST NOT use them for compilation logic.

---

## 8. Environment Variable Substitution

String values in a manifest MAY contain environment variable references using `${VAR}` or `${VAR:-default}` syntax.

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

Rules:

- Substitution MUST happen at manifest load time, before schema validation.
- `${VAR}` resolves to the value of environment variable `VAR`. If `VAR` is not set, the compiler MUST fail with a clear error naming the missing variable.
- `${VAR:-default}` resolves to the value of `VAR` if set, or `default` if not.
- Substitution applies only to string values, not to field names or structural elements.
- The `environment.secrets[*].name` field, the `shared.environment.secrets[*].name` field, and surface secret-name fields such as `bot_token_secret`, `app_token_secret`, and `signing_secret` MUST NOT be substituted — they are references to environment variable names, not values.
- Substitution MUST NOT be recursive. A resolved value containing `${...}` is treated as a literal string.

This allows the same Spawnfile to be compiled with different configurations by changing environment variables or providing a `.env` file, without duplicating the manifest.

---

## 9. CLI

### 9.1 Commands

The v0.1 CLI exposes these primary commands:

```
spawnfile init [path] [--team] [--runtime <name>]
spawnfile add agent <id> [path] [--runtime <name>]
spawnfile add subagent <id> [path]
spawnfile add team <id> [path]
spawnfile surface add <surface> [path]
spawnfile surface remove <surface> [path]
spawnfile surface set-access <surface> [path] --mode <mode>
spawnfile surface show [path]
spawnfile model set <provider> <name> [path]
spawnfile model add-fallback <provider> <name> [path]
spawnfile model clear-fallbacks [path]
spawnfile validate [path]
spawnfile view [path]
spawnfile compile [path] [--out <dir>]
spawnfile status [path | <image-ref>] [--out <dir>] [--live] [--deployment <name>] [--image] [--pull] [--pull-check]
spawnfile up [path | <image-ref>] [--out <dir>] [--auth-profile <name>] [--env-file <file>] [--detach] [--deployment <name>] [--context <name>] [--image] [--pull]
spawnfile build [path] [--out <dir>] [--tag <image>]
spawnfile run [path] [--out <dir>] [--tag <image>] [--auth-profile <name>] [--env-file <file>] [--detach] [--deployment <name>] [--context <name>]
spawnfile publish [path] --tag <image-ref> [--out <dir>]
```

See `DISTRIBUTION.md` for `publish`, image-reference `up`/`status`, and the `--image`/`--pull`/`--pull-check` flags.

### Exit Codes

All commands share one convention:

- `0` — success.
- `2` — usage or input error: bad flags or arguments, a missing or unresolvable project path or image reference, and invalid or malformed manifests.
- `1` — runtime failure: a compile, build, Docker, or other operation that failed after input validation passed.

Per-command notes below reference this convention rather than restating exit numbers.

#### `spawnfile init`

Scaffolds a new Spawnfile project in the current directory.

- `path` is the directory to initialize (default: current directory)
- `--team` scaffolds a team project instead of an agent project
- `--runtime <name>` selects the bundled runtime for agent scaffolds (default: `openclaw`)
- `--runtime` MUST be rejected when `--team` is also provided
- MUST create a `Spawnfile` manifest and any required directory structure
- SHOULD ensure the default generated output directory is ignored in the project `.gitignore`
- MUST NOT overwrite existing files

#### `spawnfile add`

Adds a child node under an existing Spawnfile project.

- `[path]` is optional and defaults to the current directory
- `path` MUST point to the parent project directory or its `Spawnfile`
- child directories MUST use conventional locations:
  - `agents/<id>/`
  - `subagents/<id>/`
  - `teams/<id>/`
- MUST rewrite the parent `Spawnfile` to append the new child ref
- MUST reject duplicate child ids
- MUST reject existing child directories

`spawnfile add agent <id> [path] [--runtime <name>]`

- MUST only work when `path` resolves to a team manifest
- MUST scaffold a new agent project at `agents/<id>/`
- MUST use the selected runtime for the new team member when `--runtime` is provided
- MUST use the same default agent runtime as `spawnfile init` when `--runtime` is omitted

`spawnfile add subagent <id> [path]`

- MUST only work when `path` resolves to an agent manifest
- MUST scaffold a new agent project at `subagents/<id>/`
- MUST inherit the parent agent runtime for the new subagent

`spawnfile add team <id> [path]`

- MUST only work when `path` resolves to a team manifest
- MUST scaffold a new team project at `teams/<id>/`

#### `spawnfile model`

Edits model declarations in authored Spawnfiles.

- `[path]` is optional and defaults to the current directory
- `path` MUST point to the target project directory or its `Spawnfile`
- `--recursive` SHOULD update the target manifest and all descendant manifests reachable through `members[*].ref` and `subagents[*].ref`
- If `path` resolves to a team manifest, implementations MUST require `--recursive` and MUST only rewrite descendant agent manifests, not the team manifest itself
- Implementations SHOULD normalize touched manifests to the canonical inline model-target form and SHOULD NOT emit legacy top-level `execution.model.auth` when rewriting manifests

`spawnfile model set <provider> <name> [path]`

- MUST set `execution.model.primary` on the target manifest
- MUST reject auth method names such as `api_key`, `claude-code`, `codex`, and `none` when they are passed in the `<provider>` position
- MAY set inline `auth` on that model target when `--auth` and `--key` are provided
- MAY set inline `endpoint` on that model target when `--compat` and `--base-url` are provided

`spawnfile model add-fallback <provider> <name> [path]`

- MUST append the model target to `execution.model.fallback`
- MUST fail when the target manifest has no primary model unless `--recursive` is used and the implementation explicitly skips manifests that do not declare a primary model
- MAY set inline `auth` and `endpoint` on the added fallback model target

`spawnfile model clear-fallbacks [path]`

- MUST remove `execution.model.fallback`

#### `spawnfile surface`

Edits declared communication surfaces.

- `[path]` is optional and defaults to the current directory
- `path` MUST point to the target project directory or its `Spawnfile`
- source-editing commands SHOULD rewrite touched manifests into canonical surface order
- if `path` resolves to a team manifest, mutating commands MUST require `--recursive` and MUST only rewrite descendant agent manifests, not the team manifest itself

`spawnfile surface add <surface> [path]`

- MUST add the named surface block when it is missing
- MAY update token-secret fields on an already-declared surface block
- MUST reject secret flags that are invalid for the selected surface
- MUST validate the resulting declared surface against the selected runtime when the target agent already declares a runtime

`spawnfile surface remove <surface> [path]`

- MUST remove the named surface block from the target manifest
- SHOULD remove the top-level `surfaces` block entirely when it becomes empty

`spawnfile surface set-access <surface> [path] --mode <mode>`

- MUST only operate on an already-declared surface block unless `--recursive` is used and the implementation explicitly skips manifests where that surface is absent
- MUST set the surface access mode to a value supported by the selected surface
- MUST validate allowlist identifiers according to the selected surface:
  - Discord: `users`, `guilds`, `channels`
  - Telegram: `users`, `chats`
  - WhatsApp: `users`, `groups`
  - Slack: `users`, `channels`

`spawnfile surface show [path]`

- MUST print the currently declared surface blocks for the selected manifest
- MAY support `--recursive` to list descendant agent manifests in a team graph

#### `spawnfile validate`

Validates a Spawnfile project without compiling.

- `path` is the directory containing the Spawnfile (default: current directory)
- MUST perform schema validation and file reference checks
- MUST walk the manifest graph and detect cycles
- MUST NOT invoke runtime adapters or emit output files
- Exit codes follow the shared convention (§9.1): invalid input or a missing path exits 2

#### `spawnfile view`

Renders a read-only, pre-compile inspection view of the resolved Spawnfile graph.

- `path` is the directory containing the Spawnfile or the Spawnfile path itself (default: current directory)
- `--mode <mode>` selects the view mode; Phase 1 modes are `tree` and `networks`
- `--show <items>` accepts a comma-separated list of Phase 1 detail layers: `paths` and `declared`
- `--paths` is a shortcut for `--show paths`
- `--ascii` uses portable ASCII connectors instead of Unicode connectors in tree and networks renderers
- `--color <when>` controls terminal color and MUST accept `auto`, `always`, and `never`
- MUST default to `--mode tree`
- MUST treat the positional argument as a project path, not a mode name; for example, `spawnfile view networks` means inspect `./networks`
- MUST operate from the same resolved graph used by `spawnfile validate`
- MUST NOT call the compile operation, invoke runtime adapters, run Docker, run Moltnet, read generated output, inspect spawned runtimes, or emit output files
- MUST render `tree` mode as the organization tree with teams, agents, nested teams, representatives, runtime names, and compact declared team-network room summaries
- MUST render networks mode as provider/network/room groupings with concrete resolved members and representative expansion
- MUST keep declared room members distinct from resolved concrete members when `--show declared` is used in networks mode
- MUST append source paths when `--paths` or `--show paths` is used
- MUST fail before rendering when graph validation fails and MUST use the same error shape as `spawnfile validate`
- Exits with code 0 on success
- Exits non-zero for CLI parse errors, invalid options, path resolution failures, validation errors, and view-model build errors

#### `spawnfile compile`

Compiles a Spawnfile project to runtime-specific output.

- `path` is the directory containing the Spawnfile (default: current directory)
- `--out` sets the output directory (default: `./.spawn`)
- MUST perform all validation, then invoke adapters and emit output
- MUST emit a compile report
- MUST enforce the project's `policy` block
- Exit codes follow the shared convention (§9.1)

#### `spawnfile status`

Renders read-only static and live status for a Spawnfile project. The detailed status contract is defined in `STATUS.md`.

- `path` is the directory containing the Spawnfile or the Spawnfile path itself (default: current directory)
- `--out` sets the output directory used to read `spawnfile-report.json` and deployment records (default: `./.spawn`)
- Without `--live`, MUST load the authored graph and MAY load the compile report if present
- Without `--live`, MUST NOT inspect Docker, run runtime health probes, call Moltnet, or read runtime homes
- `--live` reads deployment records and asks the recorded deployment manager for live observations
- `--deployment <name>` selects the deployment record for `--live`; if multiple records exist and `--live` is used without an explicit name, the command MUST fail with the known names
- `--context` MUST be rejected unless `--recover` is also present; with a record, the recorded target is the only live target
- `--json` MUST emit a stable envelope with a status schema version
- `--quiet` MUST emit only the summary and non-ok observations
- Missing compile output is `unknown` by default
- Exit code `0` means no `error` observations, `1` means at least one `error` observation, and `2` means usage or input failure

#### `spawnfile up`

Builds and starts a local lifecycle process set from source intent.
 `spawnfile up` is the required command for local lifecycle execution in v0.1.

- `path` is the directory containing the Spawnfile (default: current directory)
- `--out` sets the output directory (default: `./.spawn`)
- `--auth-profile` selects a local Spawnfile auth profile
- `--env-file` injects external env values for this local run
- `--detach` starts the generated container lifecycle in the background and writes a deployment record after successful start
- `--deployment <name>` names the detached deployment record; it defaults to `default` when detached
- `--context <name>` selects a Docker context for detached Docker execution and is recorded in the deployment record
- MAY prepare workspace resources and create/manage local runtime state paths
- MUST validate and compile as part of startup
- MUST prepare and enforce `workspace.resources`, `environment.packages`, and workspace state before spawning runtime processes
- MUST run adapter-native or managed Moltnet servers where declared
- MUST start generated Moltnet nodes and agents in one coordinated lifecycle
- MUST write `.spawn/deployments/<name>.json` only after successful detached start
- Exits with code 0 on successful process start; stays attached unless otherwise specified

#### `spawnfile build`

Builds a Docker image from compiled output.

- `path` is the directory containing the Spawnfile (default: current directory)
- `--out` sets the output directory (default: `./.spawn`)
- `--tag` sets the Docker image tag
- MUST compile the project before invoking Docker build
- MUST keep build output secrets-free by default

#### `spawnfile run`

Runs a previously built image with the compiled project's published ports and auth wiring.

- `path` is the directory containing the Spawnfile (default: current directory)
- `--out` sets the output directory used to derive the compile report (default: `./.spawn`)
- `--tag` selects the Docker image tag
- `--auth-profile` selects a local Spawnfile auth profile
- `--env-file` injects external env values into the generated Docker run environment
- `--detach` starts the container in the background and writes a deployment record after successful start
- `--deployment <name>` names the detached deployment record; it defaults to `default` when detached
- `--context <name>` selects a Docker context for detached Docker execution and is recorded in the deployment record
- MUST compile the project before deriving runtime wiring
- MUST apply model/runtime auth at run time, not build time
- MUST write `.spawn/deployments/<name>.json` only after successful detached start

#### `spawnfile publish`

Compiles, builds, verifies, and pushes the organization image to an OCI registry. Operates on a project path, not an image reference. See `DISTRIBUTION.md`.

- `--tag` is required and is the registry image reference to push
- MUST verify the embedded distribution report is path-free and secret-free before pushing
- Prints the pushed digest on success

`spawnfile up` and `spawnfile status` additionally accept an image reference in place of a project path (with `--image` to force image interpretation, `--pull` to refresh, and `--pull-check` on status for registry drift); `DISTRIBUTION.md` is the normative source for that surface. Image-mode `up` is always detached.

#### `spawnfile auth`

Manages local Spawnfile auth profiles.

- MUST support local auth profile materialization outside project source
- MAY support import of env files and existing local CLI credential stores
- SHOULD support `spawnfile auth sync` as the primary happy path for reconciling declared model-target auth intent, declared surface auth, and declared project secrets with a local auth profile

---

## 10. Deferred Features

These are intentionally excluded from the v0.1 portable core. Adapters MAY support them through runtime-specific `options` or adapter-specific extensions, but they are outside this spec.

- Channel bindings (Slack, Discord, WhatsApp, etc.)
- Memory engine configuration
- A Spawnfile package registry or discovery index (image publishing to OCI registries is supported via `spawnfile publish`; see `DISTRIBUTION.md`)
- Deployment orchestration beyond Docker detached records (Kubernetes, ECS, etc.)
- Agent lifecycle management beyond detached start/status diagnostics (restart policies, scaling, stop/down lifecycle)
- Persistent storage declarations
- UI surfaces
- Runtime-native auth bootstrap (onboarding flows)
- Agent-to-agent protocol definitions beyond declared surfaces and team networks
- Resource constraints (compute, memory, token budgets)
- Observability beyond `spawnfile status` metadata probes (structured logs, metrics, tracing)
- Dependency versioning and lock files for skills and MCP servers

---

## 11. Versioning

`spawnfile_version` MUST be a quoted string matching a published version of this spec. Compilers MUST reject manifests declaring a version they do not support and MUST NOT silently interpret unknown versions.

Current published version: `"0.1"`

---

*Spawnfile Specification v0.1 - github.com/noopolis/spawnfile*
