---
title: Adding a Runtime
description: How to add a new runtime adapter to Spawnfile.
---

## Requirements

A Spawnfile-compatible runtime must:

1. Run as a long-lived service or daemon
2. Use a markdown workspace as a first-class agent surface
3. Expose a declarative config surface the compiler can emit to

## Steps

### 1. Add to the Registry

Add an entry to `runtimes.yaml` with `status: exploratory`:

```yaml
myruntime:
  remote: git@github.com:org/myruntime.git
  ref: v1.0.0
  default_branch: main
  status: exploratory
```

### 2. Research

Clone the runtime and study its config format:

```bash
./scripts/runtimes.sh myruntime
./scripts/blueprints.sh myruntime
```

Document findings in `specs/research/RUNTIME-NOTES.md`.

### 3. Build the Adapter

Create `src/runtime/myruntime/adapter.ts` implementing the `RuntimeAdapter` interface:

- `compileAgent(node)` -- emit runtime-native config and workspace files
- `compileTeam(node)` -- optional, for runtimes with native team support
- `validateRuntimeOptions(options)` -- optional, validate runtime-specific options

### 4. Register

Add the adapter to `src/runtime/registry.ts`.

### 5. Test

Write tests in `src/runtime/myruntime/adapter.test.ts`. Verify output matches the blueprint.

### 6. Promote

Once tests pass and the adapter produces valid output, change status to `active` in `runtimes.yaml`.
