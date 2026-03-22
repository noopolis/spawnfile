---
title: Runtime Registry
description: How the Spawnfile project tracks, pins, and categorizes runtimes through runtimes.yaml, including version pinning, status tracking, and the adapter lifecycle.
---

This document specifies how the Spawnfile project tracks, pins, and categorizes the runtimes it targets.

---

## Purpose

The compiler emits output for specific runtimes. Those runtimes are external projects with their own release cadences. The runtime registry is the mechanism for:

- declaring which runtimes the project knows about
- pinning the version each adapter was written and tested against
- tracking which runtimes have active adapters vs which are still under research

---

## Registry File

The runtime registry is a YAML file at the repository root: `runtimes.yaml`.

### Schema

```yaml
runtimes:
  <name>:
    remote: <git clone URL>
    ref: <pinned git ref -- tag, SHA, or branch>
    default_branch: <main | master>
    status: <active | exploratory | deprecated>
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `remote` | yes | Git clone URL for the runtime repository |
| `ref` | yes | Pinned git ref -- should be the latest stable release tag |
| `default_branch` | yes | The repository's primary branch name |
| `status` | yes | Lifecycle status of this runtime in the Spawnfile project |

### Status Values

| Status | Meaning |
|--------|---------|
| `active` | Has a working compiler adapter in `src/runtime/<name>/` |
| `exploratory` | Research exists in `specs/research/RUNTIME-NOTES.md` but no adapter yet |
| `deprecated` | Was previously active, adapter is no longer maintained |

---

## Version Pinning

### Why Pin

Runtime APIs, config formats, and CLI interfaces change across versions. An adapter written against openclaw v2026.2.3 may not produce valid output for v2026.3.13. Pinning makes this explicit.

### What To Pin

The `ref` field should point to the latest **stable** release tag. Stable means:

- no pre-release suffixes like `-alpha`, `-beta`, `-rc`, `-dev`
- exception: if a runtime only publishes pre-release tags, pin the most recent one and note it

### When To Bump

Bump `ref` when:

- a new stable release is available and the adapter has been verified against it
- the adapter is being updated to support new runtime features from a newer version

Do not bump `ref` speculatively. The pin represents "the adapter works at this version."

### Sync Script

`scripts/runtimes.sh` reads `runtimes.yaml` and clones or checks out each runtime at its pinned ref.

```bash
./scripts/runtimes.sh              # sync all runtimes
./scripts/runtimes.sh openclaw     # sync one runtime
```

The cloned repositories live in `runtimes/` at the repo root. This directory is gitignored.

These local clones are for research, blueprint generation, and adapter development. `spawnfile compile` should not require local runtime clones on the compiler machine; container build/install should use the registry pin plus the adapter's install strategy.

---

## Adapter Lifecycle

### Adding A New Runtime

1. Add an entry to `runtimes.yaml` with `status: exploratory`
2. Run `./scripts/runtimes.sh <name>` to clone it
3. Research the runtime and add findings to `specs/research/RUNTIME-NOTES.md`
4. When ready to implement, create `src/runtime/<name>/adapter.ts` and change status to `active`

### Promoting To Active

A runtime moves from `exploratory` to `active` when:

- an adapter exists in `src/runtime/<name>/`
- the adapter passes tests against the pinned version
- the adapter is registered in `src/runtime/registry.ts`
- the compiled output can be built and the runtime can boot at the pinned version
- if the runtime exposes a host-reachable service, a host-side smoke check succeeds against that service

### Deprecating A Runtime

A runtime moves to `deprecated` when:

- the upstream project is archived or abandoned
- the adapter is no longer maintained
- the runtime's config surface has diverged beyond reasonable adapter maintenance

Deprecated runtimes stay in the registry for reference but the compiler should warn when targeting them.

Operational discoveries about a pinned runtime version -- build quirks, auth surfaces, health endpoints, container boot behavior -- should be recorded in `specs/research/RUNTIME-NOTES.md`.

---

## Relationship To Other Specs

- The [Spawnfile Specification](/spec/spec/) defines the `runtime` field in manifests -- the name must match a registered runtime
- The [Compiler Specification](/spec/compiler/) defines how runtime adapters are invoked and how output is grouped by runtime
- The [Container Compilation spec](/spec/containers/) defines how runtime container metadata is used to generate Dockerfiles
- `research/RUNTIME-NOTES.md` contains the per-runtime research that informs adapter design
