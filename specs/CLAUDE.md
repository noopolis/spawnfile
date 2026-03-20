# Specs Guide

## Structure

```text
specs/
├── INDEX.md                 # Map of all specs with status and relationships
├── SPEC.md                  # Canonical Spawnfile source schema and semantics
├── COMPILER.md              # Compiler architecture and internal contracts
├── CONTAINERS.md            # Container compilation spec
├── RUNTIMES.md              # Runtime registry, version pinning, adapter lifecycle
├── research/
│   └── RUNTIME-NOTES.md     # Per-runtime research, team lowering patterns, adapter notes
└── CLAUDE.md                # Guidance for maintaining this folder
```

This folder holds the design source of truth for the project. Implementation changes in `src/` should stay aligned with the normative specs (`SPEC.md`, `COMPILER.md`, `CONTAINERS.md`, `RUNTIMES.md`).

Documents in `research/` are informative — they inform decisions but are not binding on implementations.

## Rules

- Keep the canonical spec in `SPEC.md`.
- Keep `INDEX.md` updated when adding, renaming, or removing spec documents.
- Keep rationale and research documents in `research/`, not alongside normative specs.
- Do not let research documents drift from the implemented compiler.
- Update cross-references when files are renamed or moved.
