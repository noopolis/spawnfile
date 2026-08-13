# Specs Guide

## Structure

```text
specs/
├── INDEX.md                 # Map of all specs with status and relationships
├── SPEC.md                  # Canonical Spawnfile source schema and semantics
├── COMPILER.md              # Compiler architecture and internal contracts
├── CONTAINERS.md            # Container compilation spec
├── RUNTIMES.md              # Runtime registry, version pinning, adapter lifecycle
├── CAUSAL.md                # Shared causal wire and Stele read/verify contract
├── ECOSYSTEM_RUNTIME_BOUNDARIES.md # Cross-project runtime authority and enforcement gates
├── research/
│   ├── AUTH-NOTES.md        # Authentication research and implementation notes
│   ├── DIRECT-SURFACES.md   # Direct protocol surface research
│   ├── DIRECTION.md         # Consolidated design direction
│   ├── MEMORY-BACKENDS.md   # Portable memory-backend research
│   └── RUNTIME-NOTES.md     # Per-runtime research and adapter notes
├── AGENTS.md                # Canonical guidance for maintaining this folder
└── CLAUDE.md                # Compatibility symlink to AGENTS.md
```

This folder holds the design source of truth for the project. Implementation changes in `src/` should stay aligned with the normative specs, including `ECOSYSTEM_RUNTIME_BOUNDARIES.md`.

Documents in `research/` are informative — they inform decisions but are not binding on implementations.

## Rules

- Keep the canonical spec in `SPEC.md`.
- Keep `INDEX.md` updated when adding, renaming, or removing spec documents.
- Keep durable research that still informs the product in `research/`; do not
  commit point-in-time audit dumps, execution logs, or task trackers as specs.
- Do not let retained research documents drift from the implemented compiler.
- Update cross-references when files are renamed or moved.
