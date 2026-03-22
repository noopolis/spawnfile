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

### 0.1 What Spawnfile Targets

Spawnfile is a canonical authoring format for **autonomous agent runtimes**: systems that host agents as long-lived services rather than tools invoked per task.

Spawnfile targets runtimes whose authoring model centers on a **markdown workspace**: a persistent directory of Markdown documents that define agent identity, behavior, and operating context, and that the agent can read and update during operation.

A runtime is **Spawnfile-compatible** when it satisfies all of these hard gates:

- It runs as a long-lived service or daemon.
- It uses a markdown workspace as a first-class agent surface.
- It exposes a declarative configuration surface that a compiler can emit.

### 0.2 Portable Surface

Spawnfile v0.1 defines a portable surface that adapters attempt to preserve across compatible runtimes. These are portability targets, not runtime-admission requirements:

- markdown document roles (`identity`, `soul`, `system`, `memory`, `heartbeat`, `extras`)
- skills with `SKILL.md`
- MCP server declarations
- runtime binding and execution intent
- team structure and shared surfaces
- optional runtime capabilities such as communication surfaces, memory backends, periodic tasks, proactive behavior, and multi-agent coordination

If a runtime cannot preserve part of this surface exactly, the adapter reports `supported`, `degraded`, or `unsupported` according to compile policy.

### 0.3 Non-Target Systems

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

### 1.3 Path Resolution

All `ref` values and document file paths in a manifest are relative paths resolved from the manifest's directory.

- Paths MUST use forward slashes regardless of host OS.
- Paths MUST NOT escape the project root via `..` traversal.
- Symlinks MUST NOT be followed during compilation.
- A skill `ref` MUST point to a directory containing a `SKILL.md`.
- A member `ref` MUST point to a directory containing a `Spawnfile`.
- A document path MUST point to a UTF-8 Markdown file within the project root.

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

The `docs` block declares portable markdown surfaces. Compilers map these roles to target-specific surfaces. Document contents are author text; this spec does not define their runtime behavior.

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

- All `docs` fields are OPTIONAL.
- Paths in `docs` MUST resolve to Markdown files within the project root.
- A conforming compiler MUST treat document contents as opaque text and MUST NOT reinterpret them as structured schema.
- Team-level `docs` describe the team manifest itself and MUST NOT automatically propagate to members.

### 2.2 Skills

Each entry in `skills` MUST have a `ref` pointing to a skill directory. A skill directory MUST contain a `SKILL.md` file.

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

Each entry in `mcp_servers` MUST have a unique `name` within its manifest scope. `name` values are logical identifiers, not runtime-specific instance ids.

`transport` MUST be one of: `stdio`, `streamable_http`, `sse`.

Transport requirements:

- `stdio` MUST declare `command`. It MAY declare `args` and `env`.
- `streamable_http` MUST declare `url`.
- `sse` MUST declare `url`.

Example:

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

Rules:

- `auth.secret` SHOULD be an environment variable name, not a literal credential value.
- Adapters MAY lower a logical MCP declaration into a runtime's native MCP config format.

### 2.4 Runtime Binding

The `runtime` field declares which runtime adapter should compile a manifest.

```yaml
runtime: openclaw
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
    auth:
      methods:
        anthropic: claude-code
        openai: codex
    primary:
      provider: anthropic
      name: claude-sonnet-4-5
    fallback:
      - provider: openai
        name: gpt-4o-mini
  workspace:
    isolation: isolated    # isolated | shared
  sandbox:
    mode: workspace        # workspace | sandboxed | unrestricted
```

Rules:

- `execution.model.primary.provider` and `execution.model.primary.name` are REQUIRED if `execution.model` is present.
- `execution.model.fallback` is OPTIONAL and declares an ordered list of fallback models.
- `execution.model.auth` is OPTIONAL.
- `execution.model.auth.method` MAY declare one auth method for all declared model providers.
- `execution.model.auth.methods` MAY declare auth methods per provider.
- Supported auth methods in v0.1 are: `api_key`, `claude-code`, `codex`.
- `execution.model.auth` MUST declare exactly one of `method` or `methods`.
- If `execution.model.auth.methods` is used, it MUST cover every declared provider in `primary` and `fallback`, and it MUST NOT declare providers that are not present in that model set.
- If `execution.model.auth` is omitted, the effective auth method defaults to `api_key` for each declared provider.
- `execution.workspace.isolation` MUST be one of: `isolated`, `shared`.
- `execution.sandbox.mode` MUST be one of: `workspace`, `sandboxed`, `unrestricted`.
- If `execution.workspace` is omitted, the effective isolation defaults to `isolated`.
- If `execution.sandbox` is omitted, the effective sandbox mode defaults to `workspace`.
- Compilers MUST treat these values as author intent and map them to runtime-native configuration.
- Compilers MUST reject runtime/auth combinations that the selected runtime adapter does not support.
- If exact semantics cannot be preserved, the compiler MUST report `degraded` or `unsupported` according to the compile policy.

### 2.6 Environment and Secrets

`env` is an OPTIONAL flat key-value map of non-secret environment values. Values MUST be strings.

`secrets` is an OPTIONAL list. Each entry MUST have:

```yaml
- name: SEARCH_API_KEY
  required: true
```

Compilers SHOULD warn when a secret is marked `required` but is not present in the execution environment used for compilation or deployment.

---

## 3. Agent Schema

### 3.1 Full Manifest

```yaml
spawnfile_version: "0.1"
kind: agent
name: analyst

docs:
  identity: IDENTITY.md
  soul: SOUL.md
  system: AGENTS.md
  memory: MEMORY.md
  heartbeat: HEARTBEAT.md
  extras:
    notes: docs/NOTES.md

skills:
  - ref: ./skills/web_search
    requires:
      mcp:
        - web_search
  - ref: ./skills/memory_store
    requires:
      mcp:
        - memory_store

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

runtime:
  name: openclaw
  options:
    profile: default

execution:
  model:
    auth:
      method: api_key
    primary:
      provider: anthropic
      name: claude-sonnet-4-5
    fallback:
      - provider: openai
        name: gpt-4o-mini
  workspace:
    isolation: isolated
  sandbox:
    mode: workspace

env:
  LOG_LEVEL: info

secrets:
  - name: SEARCH_API_KEY
    required: true
  - name: MEMORY_API_KEY
    required: false

policy:
  mode: strict
  on_degrade: error
```

### 3.2 Validation Scope

For an agent manifest, skill `requires.mcp` names MUST be validated against that agent's `mcp_servers` list.

All blocks other than the top-level required fields are OPTIONAL unless otherwise stated by their own rules.

### 3.3 Subagents

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
- If a target runtime has no native subagent concept, the compiler MAY lower subagents into delegate agents, routed sessions, or spawned workers, but it MUST report `degraded` if semantics are not equivalent.

### 3.4 Effective Subagent Resolution

For a subagent reference, the effective configuration is resolved as follows:

- Effective `runtime` is the parent agent's effective `runtime`.
- If the referenced subagent manifest declares `runtime`, it MUST match the parent agent's effective `runtime`. Otherwise the compiler MUST fail.
- Effective `execution` is the parent agent's `execution` deep-merged with the subagent's local `execution`, if any.
- For `execution` deep merge:
  - object fields are merged recursively
  - scalar fields replace parent values
  - arrays replace parent values wholesale
- Subagents do not implicitly inherit parent `docs`, `skills`, `mcp_servers`, `env`, or `secrets`. A subagent MAY declare any of these surfaces in its own Spawnfile manifest — they are simply not copied from the parent. Each subagent is a self-contained agent project that happens to be owned by a parent.

---

## 4. Team Schema

### 4.1 What A Team Is

A Spawnfile team is an organizational structure — not a workflow graph, not a message router, not a deployment topology.

It defines:

- who is in the team (`members`)
- what they share (`shared`)
- how the team is organized (`structure`)
- who the team is as a collective (`docs`)

The distinction between `agent` and `team` is deliberate:

- `agent` + `subagents` = one authored agent with internal helpers. Subagent orchestration is the runtime's concern.
- `team` = several first-class authored agents that belong together as an organizational unit. Team coordination happens through external communication surfaces (channels, A2A, webhooks, etc.), not through runtime internals.

Teams are:

- canonical author intent
- degradation-aware
- potentially multi-runtime

Spawnfile does not assume that every runtime has a native team config format, nested teams, shared team memory, or durable team lifecycle APIs.

Adapters MAY lower a Spawnfile team into a native team object, a flat leader/member config, routed agent sessions, or another target-native surface. If a target cannot preserve the declared structure, the compiler MUST report `degraded` or `unsupported`.

Coordination rules beyond what the structure declares (handoff protocols, escalation paths, conflict resolution) belong in the team's `docs.system` document, where LLM agents can read and follow them as natural language instructions.

See `research/RUNTIME-NOTES.md` for per-runtime team lowering research.

### 4.2 Full Manifest

```yaml
spawnfile_version: "0.1"
kind: team
name: research-cell

docs:
  system: TEAM.md

shared:
  skills:
    - ref: ./shared/skills/web_search
  mcp_servers:
    - name: web_search
      transport: streamable_http
      url: https://search.mcp.example.com/mcp
      auth:
        secret: SEARCH_API_KEY
  secrets:
    - name: SEARCH_API_KEY
      required: true

members:
  - id: orchestrator
    ref: ./agents/orchestrator
  - id: researcher
    ref: ./agents/researcher
  - id: writer
    ref: ./agents/writer

structure:
  mode: hierarchical
  leader: orchestrator

policy:
  mode: warn
  on_degrade: warn
```

### 4.3 Members

Each member MUST have a unique `id` within the team and a `ref` pointing to either an agent source project or a team source project.

The member `id` is the **slot name** — the role this agent fills in this team. The `ref` is who fills that slot. The same agent project MAY fill different slots in different teams.

Each referenced agent MUST declare its own `runtime` in its Spawnfile. Teams do not override or assign runtimes to members.

Direct members of the same team MAY be on the same runtime or on different runtimes, depending on what each member declares.

A nested team member is a black box to the outer team:

- The outer team targets the nested team as a unit by its `member.id`, not its internal members.
- The outer team MUST NOT address inner members of a nested team directly.
- The inner team's own structure is compiled separately.
- Inner members of a nested team MUST NOT interact with outer team members through the portable spec. The nested team boundary is one-way.
- If a target lacks nested team support, the compiler MAY flatten or re-express the nested team boundary, but it MUST report `degraded`.

### 4.4 Shared Surface

`shared.skills`, `shared.mcp_servers`, `shared.env`, and `shared.secrets` are OPTIONAL and are inherited by all direct members of the team.

Inheritance rules:

- Members extend the shared surface.
- Members MUST NOT remove inherited items.
- On MCP name conflict, the member-local declaration MUST win.
- On env or secret name conflict, the member-local declaration MUST win.
- The outer team's shared surface MUST NOT automatically propagate through a nested team boundary into that nested team's own members.

For validation of a shared skill's `requires.mcp`, the visible MCP scope is `shared.mcp_servers`.

For validation of a direct member's skill `requires.mcp`, the visible MCP scope is the union of inherited shared MCP servers and member-local MCP servers, with member-local names taking precedence.

### 4.5 Structure

The `structure` block defines the organizational topology of the team. It is REQUIRED for `kind: team`.

```yaml
structure:
  mode: hierarchical
  leader: orchestrator
  external: [orchestrator]
```

#### `structure.mode`

REQUIRED. Defines the team topology.

| Mode | Description |
|------|-------------|
| `hierarchical` | Leader-led team. One member is the designated leader with authority over the group. |
| `swarm` | Flat peer team. All members are equals with no formal leader. |

#### `structure.leader`

The `id` of the member who leads the team. REQUIRED when `mode` is `hierarchical`. MUST NOT be present when `mode` is `swarm`.

The leader is the default authority, escalation point, and — unless `external` overrides it — the default voice of the team to the outside world.

Adapters SHOULD map `leader` to native leader or default-agent concepts when they exist (e.g. TinyClaw's `leader_agent`, OpenClaw's default routed agent).

#### `structure.external`

OPTIONAL. A list of member `id` values that are allowed to respond to messages from outside the team (non-team-members, humans, external systems).

Members not listed in `external` are **internal-only** — they can receive messages from other team members but SHOULD NOT respond to external input directly.

Defaults:

- `hierarchical` mode: defaults to `[leader]` if not specified
- `swarm` mode: defaults to all members if not specified

Examples:

```yaml
# Leader-led, only leader talks externally (default)
structure:
  mode: hierarchical
  leader: orchestrator

# Leader-led, but researcher also responds externally
structure:
  mode: hierarchical
  leader: orchestrator
  external: [orchestrator, researcher]

# Swarm, all peers, all respond (default)
structure:
  mode: swarm

# Swarm, all peers, but only two respond externally
structure:
  mode: swarm
  external: [monitor-a, monitor-b]
```

`external` is organizational intent. Enforcement depends on the deployment surface (channel configuration, API gateway, etc.). The compiler records the intent; adapters and deployment layers SHOULD respect it when possible.

### 4.6 Team Docs

The team's `docs.system` document (typically `TEAM.md`) describes who the team is as a collective — purpose, culture, identity. It is also the place for coordination rules that go beyond what the `structure` block captures:

- Handoff protocols between members
- Escalation procedures
- Decision-making norms
- Quality standards

The team doc SHOULD reference member slot `id` values explicitly so agents can identify their role. Compilers MAY lint for drift between member IDs and the team doc content.

The team doc stays local to the team manifest. It is NOT automatically propagated to member agents. Adapters that support team context injection MAY make the team doc available to members and SHOULD report the capability outcome.

### 4.7 Team Lowering Contract

For team manifests, a conforming compiler MUST preserve the following author intent whenever the target allows it:

- which members belong to the team (slot IDs)
- the team structure mode and leader
- which members are external-facing
- which surfaces are shared versus member-local

A compiler MAY change the mechanical implementation used by the target runtime as long as the declared intent is preserved or the loss is reported as `degraded` or `unsupported`.

When `spawnfile compile` is run from a team root, the compiler MUST walk the reachable member graph and compile each agent member using that member's declared runtime.

If a team spans multiple runtimes, the compiler MAY emit multiple runtime-specific outputs as part of the same compile run.

Compilers MUST report capability outcomes for at least:

- `team.members`
- `team.structure.mode`
- `team.structure.leader`
- `team.structure.external`
- `team.shared`
- `team.nested`

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
- install or expose declared skills, or report degradation
- configure declared MCP servers, or report degradation
- map execution model intent into runtime-native model selection, or report degradation
- map execution workspace and sandbox intent into runtime-native execution policy, or report degradation
- for team manifests, lower member and routing intent, or report `unsupported`

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

`policy` is OPTIONAL. When omitted, the compiler defaults to `permissive` mode with `on_degrade: allow` — compilation always succeeds, but capability outcomes are still recorded in the compile report.

```yaml
policy:
  mode: strict      # strict | warn | permissive (default: permissive)
  on_degrade: error # error | warn | allow (default: allow)
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

At minimum, compilers MUST report outcomes for declared docs, skills, MCP servers, execution model intent, execution workspace intent, execution sandbox intent, and routing intent.

### 6.4 How It Works In Practice

Given this manifest:

```yaml
runtime: tinyclaw

mcp_servers:
  - name: web_search
    transport: streamable_http
    url: https://search.example.com/mcp

policy:
  mode: strict
  on_degrade: error
```

TinyClaw has no clear MCP surface, so the adapter reports `mcp.web_search` as `degraded`. Because `on_degrade` is `error`, the compiler fails the build and tells you exactly which capability could not be preserved.

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
- The `secrets[*].name` field and `auth.secret` field MUST NOT be substituted — they are references to environment variable names, not values.
- Substitution MUST NOT be recursive. A resolved value containing `${...}` is treated as a literal string.

This allows the same Spawnfile to be compiled with different configurations by changing environment variables or providing a `.env` file, without duplicating the manifest.

---

## 9. CLI

### 9.1 Commands

The v0.1 CLI exposes three commands:

```
spawnfile init [path] [--team] [--runtime <name>]
spawnfile validate [path]
spawnfile compile [path] [--out <dir>]
```

#### `spawnfile init`

Scaffolds a new Spawnfile project in the current directory.

- `path` is the directory to initialize (default: current directory)
- `--team` scaffolds a team project instead of an agent project
- `--runtime <name>` selects the bundled runtime for agent scaffolds (default: `openclaw`)
- `--runtime` MUST be rejected when `--team` is also provided
- MUST create a `Spawnfile` manifest and any required directory structure
- MUST NOT overwrite existing files

#### `spawnfile validate`

Validates a Spawnfile project without compiling.

- `path` is the directory containing the Spawnfile (default: current directory)
- MUST perform schema validation and file reference checks
- MUST walk the manifest graph and detect cycles
- MUST NOT invoke runtime adapters or emit output files
- Exits with code 0 on success, 1 on validation failure

#### `spawnfile compile`

Compiles a Spawnfile project to runtime-specific output.

- `path` is the directory containing the Spawnfile (default: current directory)
- `--out` sets the output directory (default: `./dist`)
- MUST perform all validation, then invoke adapters and emit output
- MUST emit a compile report
- MUST enforce the project's `policy` block
- Exits with code 0 on success, 1 on error

#### `spawnfile build`

Builds a Docker image from compiled output.

- `path` is the directory containing the Spawnfile (default: current directory)
- `--out` sets the output directory (default: `./dist`)
- `--tag` sets the Docker image tag
- MUST compile the project before invoking Docker build
- MUST keep build output secrets-free by default

#### `spawnfile run`

Runs a previously built image with the compiled project's published ports and auth wiring.

- `path` is the directory containing the Spawnfile (default: current directory)
- `--out` sets the output directory used to derive the compile report (default: `./dist`)
- `--tag` selects the Docker image tag
- `--auth-profile` selects a local Spawnfile auth profile
- MUST compile the project before deriving runtime wiring
- MUST apply model/runtime auth at run time, not build time

#### `spawnfile auth`

Manages local Spawnfile auth profiles.

- MUST support local auth profile materialization outside project source
- MAY support import of env files and existing local CLI credential stores
- SHOULD support `spawnfile auth sync` as the primary happy path for reconciling declared `execution.model.auth` intent with a local auth profile

---

## 10. Deferred Features

These are intentionally excluded from the v0.1 portable core. Adapters MAY support them through runtime-specific `options` or adapter-specific extensions, but they are outside this spec.

- Channel bindings (Slack, Discord, WhatsApp, etc.)
- Memory engine configuration
- Task schedulers and cron-style heartbeat engines
- Package publishing and registry
- Deployment orchestration (Kubernetes, ECS, etc.)
- Agent lifecycle management (restart policies, health checks)
- Persistent storage declarations
- UI surfaces
- Runtime-native auth bootstrap (onboarding flows)
- Agent-to-agent protocol definitions beyond routing intent
- Resource constraints (compute, memory, token budgets)
- Observability hooks (probes, structured logging)
- Dependency versioning and lock files for skills and MCP servers

---

## 11. Versioning

`spawnfile_version` MUST be a quoted string matching a published version of this spec. Compilers MUST reject manifests declaring a version they do not support and MUST NOT silently interpret unknown versions.

Current published version: `"0.1"`

---

*Spawnfile Specification v0.1 - github.com/noopolis/spawnfile*
