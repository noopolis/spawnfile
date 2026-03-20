# Src Guide

This folder contains all runtime code for the Spawnfile CLI and compiler.

## Structure

```text
src/
├── cli/          # User-facing command parsing and terminal entrypoints
├── compiler/     # Graph resolution, compile planning, and artifact emission
├── filesystem/   # File IO and path utilities
├── manifest/     # Spawnfile schema parsing and validation
├── report/       # Diagnostics and compile report generation
├── runtime/      # Runtime adapter contract and bundled adapters
└── shared/       # Small cross-cutting constants, types, and errors
```

Each subfolder is a boundary. Keep logic inside the narrowest folder that can own it.

## Rules

- Keep modules focused and test them in place.
- Prefer pure functions over stateful classes unless a stateful abstraction is clearly simpler.
- Shared types should live in the smallest sensible scope and be re-exported through barrels.
- Avoid cross-folder reach-through imports when a local barrel can express the boundary.
