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
- emit stable outputs plus a machine-readable compile report

It should not try to solve packaging, publishing, deployment orchestration, or runtime-native channel setup in v0.1.

---

## Compiler Pipeline

The reference pipeline is:

1. Parse the root `Spawnfile`.
2. Validate local schema and file references.
3. Walk the manifest graph through `members[*].ref` and `subagents[*].ref`.
4. Detect cycles and incompatible duplicate references.
5. Resolve effective `runtime` and `execution` for every graph node.
6. Build a normalized intermediate representation.
7. Group resolved nodes by runtime.
8. Invoke runtime adapters.
9. Emit output directories and `spawnfile-report.json`.

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
routing: {}
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

---

## Output Layout

The default output root for v0.1 should be `./dist`.

Within that root, the compiler should emit:

```text
dist/
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
- `team.structure.mode`
- `team.structure.leader`
- `team.structure.external`
- `team.shared`
- `team.nested`

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
- team routing references
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

---

## Deferred For Later Versions

These should stay out of the core compiler architecture for v0.1:

- package builders
- publish flows
- lockfile and reproducibility records
- runtime-native auth bootstrap
- public chat surfaces as portable schema
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
   - team structure with leader

If these three fixtures compile cleanly and produce stable reports, the v0.1 foundation is strong enough to start adapters.
