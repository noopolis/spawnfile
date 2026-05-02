---
title: Compiler Specification
description: The Spawnfile v0.1 compiler pipeline, graph resolution, adapter contract, intermediate representation, output layout, and compile report format.
---

This document is the implementation companion to the [Spawnfile Specification](/spec/spec/).

The spec defines the canonical source format. This document defines the reference compiler shape for v0.1.

Related specs: [Container Compilation](/spec/containers/), [Runtime Registry](/spec/runtimes/).

---

## Goals

The v0.1 compiler should do four things well:

- load a Spawnfile graph deterministically
- resolve effective runtime and execution configuration
- hand resolved nodes to runtime adapters
- emit stable outputs, generated team-context artifacts, container artifacts, and a machine-readable compile report

It should not try to solve packaging, publishing, deployment orchestration, runtime-native channel setup, or runtime coordination in v0.1. The compiler does not inject custom team routers, MCP message tools, or team-internal RPC mechanisms.

The compiler has a write-only runtime boundary. It may write generated files, config, env files, mounted credential stores, and generated secrets. It must not read spawned runtimes, containers, runtime homes, or agent workspaces to discover identity, infer organization state, rewrite rosters, or maintain live coordination state.

---

## Compiler Pipeline

The reference pipeline is:

1. Parse the root `Spawnfile`.
2. Validate local schema and file references.
3. Walk the manifest graph through `members[*].ref` and `subagents[*].ref`.
4. Detect cycles and incompatible duplicate references.
5. Resolve effective `runtime` and `execution` for every graph node.
6. Resolve `description` for every agent node.
7. Build a normalized intermediate representation.
8. Group resolved nodes by runtime.
9. Invoke runtime adapters.
10. Resolve team representatives, team-context files, roster files, and team-network artifacts.
11. Merge generated files into compiled workspaces.
12. Place or point to generated team-context orientation through each runtime's system-instruction surface when possible.
13. Attach compiler-owned capability outcomes and warning diagnostics.
14. Enforce policy after report augmentation.
15. Emit output directories and `spawnfile-report.json`.

The compiler should operate on resolved IR, not on raw YAML, after the graph phase.

---

## Graph Rules

### Node Identity

Graph nodes are keyed by canonical manifest path.

This is intentionally simple for v0.1:

- one manifest path = one logical node
- repeated refs are allowed only if they resolve identically

If the same manifest path resolves to different effective `runtime` or `execution` values in one compile graph, compilation should fail.

### Stable Node IDs

The compiler should expose a stable node id separate from the internal manifest-path key.

Recommended rule:

- start from `<kind>:<name>`
- if that collides within one compile run, append a short hash of the canonical manifest path

Examples:

- `agent:analyst`
- `team:research-cell`
- `agent:assistant#4f2a9c1d`

Output directory names should use the slug portion of that id.

### Edges

There are two edge kinds:

- `team_member`
- `subagent`

The compiler should preserve edge kind in the IR because adapters may treat them very differently.

### Cycles

Cycles are invalid in v0.1.

Examples that must fail:

- team A includes team B and team B includes team A
- agent A includes subagent B and subagent B includes subagent A
- any mixed cycle across teams and subagents

---

## Effective Resolution

The canonical resolution rules for runtime, execution, and other surfaces are defined in the spec sections 2.4, 2.5, 3.4, and 4.4. This section covers implementation notes beyond what the spec defines.

### Runtime Normalization

`runtime` should be normalized internally to:

```yaml
runtime:
  name: openclaw
  options: {}
```

even when authored as a shorthand string. This normalization happens once during graph loading so that adapters always receive a consistent shape.

### Resolution Implementation

The compiler resolves effective configuration during graph walking, not as a separate pass. Each node's effective runtime, execution, and surfaces are computed when the node is first visited, and the result is cached by canonical manifest path with a fingerprint to detect conflicting resolutions.

---

## Intermediate Representation

The compiler should normalize manifests into two node types and one plan.

### Resolved Agent

```yaml
kind: agent
id: agent:analyst
source: /abs/path/to/Spawnfile
runtime:
  name: openclaw
  options: {}
execution:
  model:
    primary:
      provider: anthropic
      name: claude-sonnet-4-5
docs: {}
skills: []
mcp_servers: []
env: {}
secrets: []
subagents: []
```

### Resolved Team

```yaml
kind: team
id: team:research-cell
source: /abs/path/to/Spawnfile
docs: {}
shared:
  skills: []
  mcp_servers: []
  env: {}
  secrets: []
members: []
mode: swarm
lead: null
external: []
networks: []
```

### Compile Plan

```yaml
root: /abs/path/to/Spawnfile
nodes: []
edges: []
runtimes:
  openclaw:
    nodes: []
  picoclaw:
    nodes: []
```

The important property is that adapters receive resolved nodes, never unresolved inheritance logic.

---

## Adapter Contract

Runtime adapters should implement the smallest interface that can work across all current runtimes.

### Required Adapter Operations

- `compileAgent`
  - required
- `compileTeam`
  - optional
- `validateRuntimeOptions`
  - optional but recommended

### Suggested Interface

```yaml
compileAgent(input):
  files: []
  capabilities: []
  diagnostics: []

compileTeam(input):
  files: []
  capabilities: []
  diagnostics: []
```

Where:

- `files`
  - emitted files relative to the node output directory
- `capabilities`
  - per-capability outcomes
- `diagnostics`
  - warnings and errors discovered by the adapter

### Team Lowering Rule

The compiler should assume this default:

- every agent node is always compilable independently by its runtime adapter
- team-level compilation is optional and adapter-dependent

That means:

- if a team's relevant members all belong to one runtime and the adapter supports teams, `compileTeam` may emit native team artifacts
- if a team spans multiple runtimes, the compiler should still compile the member agents and report any loss of native team semantics

This keeps multi-runtime teams possible without requiring a universal native team primitive.

## Team Context And Roster Compilation

When compiling a team, the compiler generates context-scoped artifacts after member resolution and adapter output.

Direct memberships receive:

```text
.spawnfile/team-contexts/<team-context-key>/TEAM.md
.spawnfile/rosters/<team-context-key>.yaml
```

If the compiled agent has exactly one direct team membership, the compiler also emits root `TEAM.md` and `.spawnfile/roster.yaml` aliases. Reusable agents with multiple direct memberships do not get those ambiguous root aliases.

Selected nested-team representatives receive parent-context artifacts:

```text
.spawnfile/team-contexts.yaml
.spawnfile/team-contexts.md
.spawnfile/team-contexts/<team-context-key>/TEAM.md
.spawnfile/rosters/<team-context-key>.yaml
.spawnfile/team-cards/<team-context-key>/<parent-member-slot-id>.md
```

`TEAM.md` is emitted literally from the team's `docs.system` source document and bypasses runtime document-role mapping. The compiler must not merge several `TEAM.md` files.

Roster v2 carries context-scoped derivable per-surface `addresses`, not routed endpoints. Moltnet FQIDs are derivable. Slack, Discord, Telegram, and WhatsApp addresses appear only when `surfaces.<name>.identity` is declared. Portable HTTP addresses never appear because `surfaces.http` is not part of the alpha surface schema.

Nested team entries stay black boxes. Parent rosters may show a team card and selected representatives, but never the child team's full internal roster.

The compiler builds a coordination graph for every emitted roster with more than one visible concrete participant. It reports warnings, not errors, for isolated participants, an empty cross-member graph, or ambiguous context selection where one surface binding maps to several contexts.

Team networks are provider-backed organizational topology. Moltnet parent-room members may name direct child-team slots; the compiler expands those slots through the child team's representative chain and attaches only selected representatives. Duplicate Moltnet `member_id` values across the reachable nested team graph fail validation. Compatible duplicate attachments for the same `(network_id, member_id)` merge rooms; incompatible duplicates fail compilation. Moltnet `reply` policy is `auto | never`.

---

## Output Layout

The default output root for v0.1 should be `./.spawn`.

Within that root, the compiler should emit:

```text
.spawn/
  spawnfile-report.json
  runtimes/
    openclaw/
      agents/
        analyst/
      teams/
        research-cell/
    picoclaw/
      agents/
        researcher/
```

Rules:

- one directory per runtime
- one stable directory per compiled node
- agent and team outputs are separated
- the report file is always emitted at the root

If a runtime adapter emits nothing for a team node, the report should still record the attempted lowering and capability outcomes.

---

## Compile Report

The report should be JSON by default and written to `spawnfile-report.json`.

### Top-Level Shape

```json
{
  "spawnfile_version": "0.1",
  "root": "/abs/path/to/Spawnfile",
  "nodes": [],
  "diagnostics": []
}
```

### Node Entry Shape

```json
{
  "id": "agent:analyst",
  "kind": "agent",
  "source": "/abs/path/to/Spawnfile",
  "runtime": "openclaw",
  "output_dir": "runtimes/openclaw/agents/analyst",
  "capabilities": [],
  "diagnostics": []
}
```

### Capability Entry Shape

```json
{
  "key": "execution.model",
  "outcome": "supported",
  "message": ""
}
```

### Canonical Capability Keys

The compiler should use these keys by default:

- `docs.identity`
- `docs.soul`
- `docs.system`
- `docs.memory`
- `docs.heartbeat`
- `docs.extras.<name>`
- `skills.<name-or-ref>`
- `mcp.<name>`
- `execution.model`
- `execution.workspace`
- `execution.sandbox`
- `agent.subagents`
- `team.members`
- `team.mode`
- `team.lead`
- `team.external`
- `team.roster`
- `team.context_orientation`
- `team.representatives`
- `team.networks`
- `team.networks.<provider>`
- `team.networks.<provider>.<network-id-key>`
- `team.shared`
- `team.nested`
- `surfaces.<name>.identity`

Adapters may add runtime-specific keys under:

- `runtime.options.*`
- `runtime.native.*`

Those keys are informative, not part of the portable core.

---

## Recommended Validation Phases

Validation should happen in three layers:

### 1. Static Validation

- YAML validity
- required fields
- path existence
- basic enum checks
- duplicate names and ids

### 2. Graph Validation

- cycle detection
- duplicate node resolution conflicts
- runtime resolution
- team representative and team-network references
- skill `requires.mcp` resolution

### 3. Adapter Validation

- runtime option validation
- runtime-native config constraints
- capability preservation checks

This split will make error reporting much easier to keep sane.

---

## Container Compilation

After adapters emit runtime-specific files, the compiler generates container artifacts at the output root.

See the [Container Compilation spec](/spec/containers/) for the full spec. The key rule is:

- one compile = one container
- the Dockerfile and entrypoint are derived from adapter-provided container metadata
- all agents, subagents, and team members in the compile graph share a single container

This adds a final stage to the pipeline:

10. Collect container metadata from each runtime adapter in the compile plan.
11. Generate `Dockerfile`, `entrypoint.sh`, and `.env.example` at the output root.

## Moltnet Team Conversation E2E

The Moltnet team-network contract requires an opt-in, release-gating E2E that compiles, builds, runs, and verifies a real parent/nested team conversation through Moltnet room history. It must prove parent room membership includes only the direct parent agent plus selected child representatives, non-representatives are absent, a real `moltnet send` exchange happens, and one representative can answer in both parent and child rooms.

---

## Deferred For Later Versions

These should stay out of the core compiler architecture for v0.1:

- package builders
- publish flows
- lockfile and reproducibility records
- runtime-native auth bootstrap
- runtime-native chat features outside declared portable surfaces
- workflow schedulers
- memory engine contracts
- multi-container orchestration (Docker Compose, Kubernetes, etc.)

---

## First Fixtures

Before building adapters, the compiler should be tested against three canonical source projects:

1. Single agent
   - one runtime
   - docs, skills, MCP, execution
2. Agent with subagents
   - inherited runtime
   - merged execution
3. Multi-runtime team
   - direct members on different runtimes
   - shared skills/MCP
   - team mode, lead, representatives, and team networks

If these three fixtures compile cleanly and produce stable reports, the v0.1 foundation is strong enough to start adapters.
