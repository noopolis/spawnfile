# Specs Index

This is the map of all specification and research documents in the Spawnfile project.

---

## Normative Specs

These are the source of truth. Implementation in `src/` must stay aligned with these.

| Document | Status | Description |
|----------|--------|-------------|
| [SPEC.md](SPEC.md) | v0.1 draft | Canonical source format — manifest schema, portable surfaces, team schema, policy, CLI, env substitution |
| [COMPILER.md](COMPILER.md) | v0.1 draft | Compiler pipeline, graph resolution, adapter contract, output layout, compile report |
| [CONTAINERS.md](CONTAINERS.md) | v0.1 draft | Container compilation — Dockerfile and entrypoint generation, run-time auth wiring, adapter container contract |
| [RUNTIMES.md](RUNTIMES.md) | v0.1 draft | Runtime registry model — version pinning, status tracking, adapter lifecycle |

## Research

Working notes and analysis. Informative, not normative. These inform spec decisions but are not binding on implementations.

| Document | Description |
|----------|-------------|
| [research/AUTH-NOTES.md](research/AUTH-NOTES.md) | Auth research and implementation notes — provider credentials, channel auth, CLI credential stores, and Spawnfile auth profile UX |
| [research/RUNTIME-NOTES.md](research/RUNTIME-NOTES.md) | Per-runtime research — config surfaces, capabilities, overlap analysis, team lowering patterns, adapter strategies |

---

## Dependency Graph

```text
SPEC.md                    ← canonical schema, everything depends on this
  ├── COMPILER.md           ← how to compile what SPEC defines
  │   └── CONTAINERS.md    ← container layer on top of compiler output
  └── RUNTIMES.md          ← which runtimes exist and how they're tracked

research/RUNTIME-NOTES.md  ← informs adapter implementation and RUNTIMES.md
research/AUTH-NOTES.md     ← informs auth/profile UX, `execution.model.auth`, and future surface provisioning
```
