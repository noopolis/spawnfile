---
title: Spawnfile Specification
description: The canonical Spawnfile v0.1 specification -- manifest schema, portable surfaces, agent and team schemas, policy, CLI, and environment variable substitution.
---

**Version:** 0.1 (draft)
**Status:** Work in progress

---

## Conventions

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

A **conforming source project** is one that satisfies all MUST requirements in this document.
A **conforming compiler** is one that correctly processes conforming source projects and reports all MUST NOT violations.

---

## 0. Scope

`spawnfile_version` remains `"0.1"` for this alpha reset. The current alpha contract is defined by this document; no `0.2` manifest version or compatibility mode is introduced here.

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
- team structure, team networks, and generated team-context artifacts
- optional runtime capabilities such as communication surfaces, memory backends, periodic tasks, and proactive behavior

If a runtime cannot preserve part of this surface exactly, the adapter reports `supported`, `degraded`, or `unsupported` according to compile policy.

### 0.3 Write-only Runtime Boundary

Spawnfile is a compiler/canonicalizer. It may write generated files, runtime-native config, env files, mounted credential stores, generated secrets, and explicit operator-triggered updates into spawned runtime environments.

Spawnfile MUST NOT read spawned runtimes, containers, runtime homes, or agent workspaces to discover identity, infer organization state, rewrite rosters, or maintain live coordination state.

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
- `execution.workspace.isolation` MUST be one of: `isolated`, `shared`.
- `execution.sandbox.mode` MUST be one of: `workspace`, `sandboxed`, `unrestricted`.
- Compilers MUST treat these values as author intent and map them to runtime-native configuration.
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

Declared secrets are runtime inputs, not literal secret values. `spawnfile auth sync --env-file <file>` MUST collect values for declared required secrets from the process environment or the provided env file and MUST fail when a required value is unavailable. Optional declared secrets SHOULD be copied into the selected auth profile when a value is available, and ignored when absent.

`spawnfile run --env-file <file>` MUST inject the provided env file values into the generated Docker run environment for that invocation. When an auth profile and run env file both define the same variable, the run env file value wins. A value from the process environment wins over both when that variable is part of the generated run environment.

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
- Subagents do not implicitly inherit parent `docs`, `skills`, `mcp_servers`, `env`, or `secrets`. A subagent MAY declare any of these surfaces in its own Spawnfile manifest -- they are simply not copied from the parent. Each subagent is a self-contained agent project that happens to be owned by a parent.

---

## 4. Team Schema

### 4.1 What A Team Is

A Spawnfile team is an organizational structure. It defines:

- who is in the team (`members`)
- what they share (`shared`)
- how the team is organized (`mode`, `lead`, `external`)
- who the team is as a collective (`docs`)
- which provider-backed team networks exist (`networks`)
- which context artifacts members receive (`TEAM.md`, rosters, team cards, and context indexes)

The distinction between `agent` and `team` is deliberate:

- `agent` + `subagents` = one authored agent with internal helpers. Subagent orchestration is the runtime's concern.
- `team` = several first-class authored agents that belong together as an organizational unit. Team coordination happens through shared declared agent surfaces and declared team networks.

Teams are:

- canonical author intent
- degradation-aware
- potentially multi-runtime

Spawnfile does not assume that every runtime has a native team config format, nested teams, shared team memory, or durable team lifecycle APIs.

Adapters MAY lower a Spawnfile team into a native team object, a flat leader/member config, provider-backed rooms, generated context files, or another target-native surface. If a target cannot preserve the declared structure, the compiler MUST report `degraded` or `unsupported`.

Spawnfile does not inject a team message tool, surface router, proxy process, or team-internal RPC mechanism. How agents reach each other depends on which surfaces they share and which addresses are knowable from authored manifests.

Coordination rules beyond what the manifest declares belong in the team's `docs.system` document.

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

mode: hierarchical
lead: orchestrator

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

The member `id` is the **slot name** -- the role this agent fills in this team. The `ref` is who fills that slot. The same agent project MAY fill different slots in different teams.

Each referenced agent MUST declare its own `runtime` in its Spawnfile. Teams do not override or assign runtimes to members.

Direct members of the same team MAY be on the same runtime or on different runtimes, depending on what each member declares.

A nested team member is a black box to the outer team:

- The outer team targets the nested team as a unit by its `member.id`, not its internal members.
- The outer team MUST NOT address arbitrary inner members of a nested team directly.
- The inner team's own structure is compiled separately.
- Parent-team communication with a nested team crosses the boundary through the child team's resolved representatives.
- Non-representative inner members do not receive parent team context just because their team is nested.
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

### 4.5 Mode, Lead, External, And Representatives

`mode`, `lead`, and `external` define the organizational topology of the team.

```yaml
mode: hierarchical
lead: orchestrator
external: [orchestrator]
```

#### `mode`

REQUIRED. Defines the team topology.

| Mode | Description |
|------|-------------|
| `hierarchical` | Leader-led team. One member slot is the designated lead who delegates and coordinates. |
| `swarm` | Flat peer team. All members are peers. |

#### `lead`

The `id` of the member slot that leads the team. REQUIRED when `mode` is `hierarchical`. MUST NOT be present when `mode` is `swarm`. The lead may be an agent or a nested team. If a nested team resolves to multiple concrete lead delegates, adapters MUST NOT silently pick one.

#### `external`

OPTIONAL. A list of direct member slot ids that represent the team in parent-team and organization-boundary contexts. It is representative intent, not router/default-agent intent.

Representative resolution is recursive:

- If `external` is declared, select those slots.
- Else if `mode: hierarchical`, select `[lead]`.
- Else if `mode: swarm`, select all direct member slots.
- If a selected slot is a nested team, resolve that child team's representative interface with the same rules.

The compiler MUST NOT include arbitrary descendants. A descendant is included only when every boundary on the path selects it through `external`, `lead`, or swarm fallback.

### 4.6 Team Networks

`team.networks[]` declares provider-backed organizational communication topology. It is different from agent-level `surfaces`.

```yaml
networks:
  - id: local_lab
    provider: moltnet
    rooms:
      - id: org-council
        members: [coordinator, research-team]
```

In v0.1, `provider` is `moltnet`. Parent room members may name direct child-team slots; those slots expand only to selected concrete representatives. Moltnet member IDs are direct agent member slot IDs and must be unique across the reachable nested team graph. Moltnet `reply` policy is `auto | never`; `manual` is not portable.

### 4.7 Team Docs And Context Artifacts

The team's `docs.system` document (typically `TEAM.md`) describes who the team is as a collective. The compiler emits it literally as a generated team-context artifact, not through the normal runtime document-role mapping.

Rules:

- Every direct membership gets `.spawnfile/team-contexts/<team-context-key>/TEAM.md`.
- Every direct membership gets `.spawnfile/rosters/<team-context-key>.yaml`.
- Root `TEAM.md` and `.spawnfile/roster.yaml` are emitted only when a compiled agent has exactly one direct team membership.
- Reusable agents with multiple direct memberships do not get ambiguous root aliases.
- Selected representatives receive parent `TEAM.md`, parent roster, team cards, `.spawnfile/team-contexts.yaml`, and `.spawnfile/team-contexts.md`.
- The compiler MUST NOT merge multiple `TEAM.md` files.
- Compiler post-processing places or points to `.spawnfile/team-contexts.md` through the compiled runtime's system-instruction surface when available.

Team manifests MUST NOT declare `execution`, `surfaces`, or `auth`.

### 4.8 Team Rosters

Rosters are context-scoped. They carry derivable per-surface `addresses`, not routed endpoints.

- Moltnet FQIDs are derivable.
- Slack, Discord, Telegram, and WhatsApp addresses require optional `surfaces.<name>.identity`.
- Portable HTTP addresses are not part of roster v2.
- No roster `auth` block exists.
- Nested team entries stay black boxes and expose only team cards plus selected representatives.

The compiler builds a coordination graph for each emitted roster with more than one visible concrete participant. It warns, not fails, when a visible participant has no shared declared coordination surface or when the graph has no edges.

### 4.9 Team Lowering Contract

For team manifests, a conforming compiler MUST preserve the following author intent whenever the target allows it:

- which members belong to the team (slot IDs)
- the team mode, lead, and representative interface
- which surfaces are shared versus member-local
- declared team networks
- generated team-context artifacts

A compiler MAY change the mechanical implementation used by the target runtime as long as the declared intent is preserved or the loss is reported as `degraded` or `unsupported`.

When `spawnfile compile` is run from a team root, the compiler MUST walk the reachable member graph and compile each agent member using that member's declared runtime.

If a team spans multiple runtimes, the compiler MAY emit multiple runtime-specific outputs as part of the same compile run.

Compilers MUST report capability outcomes for at least:

- `team.members`
- `team.mode`
- `team.lead`
- `team.external`
- `team.shared`
- `team.nested`
- `team.roster`
- `team.context_orientation`
- `team.representatives`
- `team.networks`
- `team.networks.<provider>`
- `team.networks.<provider>.<network-id-key>`
- `surfaces.<name>.identity`

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

Consider: you declare an agent with MCP servers and compile it to a runtime that has no MCP surface. The compiler can detect this gap -- but should it fail the build, warn you, or quietly continue? Different projects need different answers. A production deployment may want strict enforcement. A prototype may want to compile whatever it can and move on.

### 6.2 Policy Declaration

`policy` is OPTIONAL. When omitted, the compiler defaults to `permissive` mode with `on_degrade: allow` -- compilation always succeeds, but capability outcomes are still recorded in the compile report.

```yaml
policy:
  mode: strict      # strict | warn | permissive (default: permissive)
  on_degrade: error # error | warn | allow (default: allow)
```

`mode` controls how the compiler handles uncertainty or missing fidelity:

- `strict` -- the compiler MUST fail on any capability it cannot verify or preserve
- `warn` -- the compiler MUST emit a warning and MAY continue
- `permissive` -- the compiler MAY continue, but it MUST still record the capability outcome in the compile report

`on_degrade` controls behavior when the compiler determines a capability is `degraded` (partially mapped but not fully equivalent):

- `error` -- compilation MUST fail
- `warn` -- compilation continues with a warning
- `allow` -- compilation continues silently

Unsupported capabilities are always at least warnings, and in `strict` mode they MUST fail compilation.

### 6.3 Capability Outcomes

For every declared capability the compiler MUST report one of:

| Outcome | Meaning |
|---------|---------|
| `supported` | Fully preserved in the target with equivalent intent |
| `degraded` | Partially mapped; runtime behavior may differ from declared intent |
| `unsupported` | Cannot be expressed in the target |

At minimum, compilers MUST report outcomes for declared docs, skills, MCP servers, execution model intent, execution workspace intent, execution sandbox intent, declared surfaces, and team context/network intent.

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

Change `on_degrade` to `warn` and the build succeeds -- but the compile report still records the degradation so you know what was lost.

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
- The `secrets[*].name` field and surface secret-name fields such as `bot_token_secret`, `app_token_secret`, and `signing_secret` MUST NOT be substituted -- they are references to environment variable names, not values.
- Substitution MUST NOT be recursive. A resolved value containing `${...}` is treated as a literal string.

This allows the same Spawnfile to be compiled with different configurations by changing environment variables or providing a `.env` file, without duplicating the manifest.

---

## 9. CLI

### 9.1 Commands

The v0.1 CLI exposes these primary commands:

```
spawnfile init [--team]
spawnfile validate [path]
spawnfile view [path]
spawnfile compile [path] [--out <dir>]
```

#### `spawnfile init`

Scaffolds a new Spawnfile project in the current directory.

- `--team` scaffolds a team project instead of an agent project
- MUST create a `Spawnfile` manifest and any required directory structure
- MUST NOT overwrite existing files

#### `spawnfile validate`

Validates a Spawnfile project without compiling.

- `path` is the directory containing the Spawnfile (default: current directory)
- MUST perform schema validation and file reference checks
- MUST walk the manifest graph and detect cycles
- MUST NOT invoke runtime adapters or emit output files
- Exits with code 0 on success, 1 on validation failure

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
- Exits with code 0 on success, 1 on error

### 9.2 Future Commands

`spawnfile build` is reserved for container image building once the container compilation spec (`CONTAINERS.md`) is implemented. It will build a Docker image from compiled output.

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
- Agent-to-agent protocol definitions beyond declared surfaces and team networks
- Resource constraints (compute, memory, token budgets)
- Observability hooks (probes, structured logging)
- Dependency versioning and lock files for skills and MCP servers

---

## 11. Versioning

`spawnfile_version` MUST be a quoted string matching a published version of this spec. Compilers MUST reject manifests declaring a version they do not support and MUST NOT silently interpret unknown versions.

Current published version: `"0.1"`

---

*Spawnfile Specification v0.1 - github.com/noopolis/spawnfile*
