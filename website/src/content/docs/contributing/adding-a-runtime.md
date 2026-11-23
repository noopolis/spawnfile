---
title: Adding a Runtime
description: How to add a new runtime adapter to Spawnfile.
---

## Bring your own harness

Create an ESM module with a named `spawnfileAdapter` export. Its runtime name, container settings and config writer describe how Spawnfile builds your agent. The public `spawnfile/adapter` entry point exports types and the optional `RuntimeAdapterBase` class.

Declare each module once under `adapters` in the root Spawnfile. Each agent selects the name of its adapter. Packages and relative paths can be used in the same team.

```yaml
spawnfile_version: "0.1"
kind: team
name: harness-workshop
adapters:
  echo-harness: "@spawnfile-fixtures/echo-adapter"
  word-count: ./word-count/adapter.mjs
mode: swarm
members:
  - id: echo
    runtime: { name: echo-harness }
    workspace: { docs: { system: AGENTS.md } }
  - id: counter
    runtime: { name: word-count }
    workspace: { docs: { system: AGENTS.md } }
```

The working example includes both modules and their project files. [Example team](https://github.com/noopolis/spawnfile/tree/main/fixtures/external-runtime-adapter) · [Typed adapter implementation](https://github.com/noopolis/spawnfile/blob/main/specs/RUNTIME_ADAPTERS.md#implement-an-adapter)

## Contribute a bundled adapter

### 1. Add to the Registry

Add an entry to `runtimes.yaml` with `status: exploratory`:

```yaml
myruntime:
  remote: git@github.com:org/myruntime.git
  ref: v1.0.0
  default_branch: main
  install:
    kind: npm
    package: myruntime
    version: 1.0.0
  status: exploratory
```

The `install` block is the compiled install surface Spawnfile will use when it builds containers. Exploratory runtimes can start without a verified install strategy, but active runtimes intended for `spawnfile build` should declare one in `runtimes.yaml`.

### 2. Research

Study the pinned upstream source and its config format. Capture a frozen
reference layout under `blueprints/<name>/` when the runtime exposes a
declarative configuration surface, then document findings in
`specs/research/RUNTIME-NOTES.md`.

### 3. Build the Adapter

Create `src/runtime/myruntime/adapter.ts` implementing the `RuntimeAdapter` interface:

- `compileAgent(node)` -- emit runtime-native config and workspace files
- `compileTeam(node)` -- optional, for runtimes with native team support
- `validateRuntimeOptions(options)` -- optional, validate runtime-specific options

### 4. Register

Register the adapter with the built-in runtime composition. Follow the existing adapter layout under `src/runtime/`.

### 5. Test

Write tests in `src/runtime/myruntime/adapter.test.ts`. Verify output matches the blueprint, the generated container can install the pinned runtime, and any host-reachable service has a smoke check.

### 6. Promote

Once tests pass, the adapter produces valid output, and the build/install smoke path works, change status to `active` in `runtimes.yaml`.
