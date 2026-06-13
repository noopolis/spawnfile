# Specs Index

This is the map of all specification and research documents in the Spawnfile project.

---

## Normative Specs

These are the source of truth. Implementation in `src/` must stay aligned with these.

| Document | Status | Description |
|----------|--------|-------------|
| [SPEC.md](SPEC.md) | evolving | Canonical source format — manifest schema, portable surfaces, team schema with roster, policy, CLI, env substitution |
| [COMPILER.md](COMPILER.md) | evolving | Compiler pipeline, graph resolution, roster compilation, adapter contract, output layout, compile report |
| [CONTAINERS.md](CONTAINERS.md) | evolving | Container compilation — Dockerfile and entrypoint generation, run-time auth wiring, adapter container contract |
| [SURFACES.md](SURFACES.md) | evolving | Communication surfaces — platform messaging, HTTP, webhook, runtime support matrix, and lowering notes |
| [RUNTIMES.md](RUNTIMES.md) | evolving | Runtime registry model — version pinning, status tracking, adapter lifecycle |
| [STATUS.md](STATUS.md) | evolving | Operational status — static and live status, deployment records, Docker targets, runtime probes, and Moltnet metadata-only diagnostics |
| [DISTRIBUTION.md](DISTRIBUTION.md) | evolving | Image distribution — self-describing images, sourceless run/status, deployment record v2, publish, registry drift, and the network binding contract |

## Research

Working notes and analysis. Informative, not normative. These inform spec decisions but are not binding on implementations.

| Document | Description |
|----------|-------------|
| [research/AUTH-NOTES.md](research/AUTH-NOTES.md) | Auth research and implementation notes — provider credentials, channel auth, CLI credential stores, and Spawnfile auth profile UX |
| [research/DIRECT-SURFACES.md](research/DIRECT-SURFACES.md) | Direct protocol surface research — `http`, `webhook`, `a2a`, shared envelope design, and future shared-network compatibility rules |
| [research/DIRECTION.md](research/DIRECTION.md) | Design direction and roadmap — consolidated findings from 21 design discussions, feature status, implementation priority |
| [research/RUNTIME-NOTES.md](research/RUNTIME-NOTES.md) | Per-runtime research — config surfaces, capabilities, overlap analysis, team lowering patterns, adapter strategies |

---

## Dependency Graph

```text
SPEC.md                    ← canonical schema, everything depends on this
  ├── COMPILER.md           ← how to compile what SPEC defines
  │   └── CONTAINERS.md    ← container layer on top of compiler output
  ├── SURFACES.md          ← portable communication-surface contract and runtime support matrix
  ├── RUNTIMES.md          ← which runtimes exist and how they're tracked
  └── STATUS.md            ← operational status contract over authored, compiled, deployed, runtime, and network layers

research/RUNTIME-NOTES.md  ← informs adapter implementation and RUNTIMES.md
research/AUTH-NOTES.md     ← informs auth/profile UX, per-model auth/endpoint config, and future surface provisioning
research/DIRECT-SURFACES.md ← informs direct `http` / `webhook` / `a2a` surface design and future shared-network compatibility
research/DIRECTION.md      ← consolidated design direction and roadmap from 21 discussions
```
