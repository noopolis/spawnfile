# Spawnfile Working Guide

This repository is the reference implementation of the Spawnfile v0.1 compiler.

## Repository Structure

```text
.
├── README.md                 # Project overview and install/use flow
├── runtimes.yaml             # Runtime registry — pinned versions and status
├── blueprints/               # Frozen reference layouts per runtime at pinned version
├── fixtures/                 # Canonical example Spawnfile projects
├── specs/                    # Specs, architecture docs, and runtime research
├── scripts/                  # Bootstrap and repo helper scripts
├── src/                      # CLI, compiler, adapters, manifests, reports
├── package.json              # Node package metadata and CLI scripts
├── tsconfig.json             # Typecheck config
├── tsconfig.build.json       # Build-only emit config
└── vitest.config.ts          # Test and coverage configuration
```

`src/` is the implementation root. Every subfolder there should explain its own local structure in a nested `CLAUDE.md`.

## General Rules

- Keep the implementation aligned with the normative specs: `specs/SPEC.md`, `specs/COMPILER.md`, `specs/CONTAINERS.md`, and `specs/RUNTIMES.md`.
- Prefer small, composable modules with explicit responsibilities.
- Do not allow source files to grow past 400 lines. Split early when files start creeping up.
- Use named exports only. Do not introduce default exports.
- Use barrel exports for folder entry points.
- Keep test files next to the files they cover: `file.ts` and `file.test.ts`.
- Aim for 90% or better coverage.
- Do not reinvent well-understood workflows when a stable precedent exists. Learn from Docker-style ergonomics where it helps.

## Folder Rules

- Every implementation folder must have its own nested `CLAUDE.md`.
- Nested guides should describe the structure of that area, what each file is for, and any local design constraints.
- When creating a new implementation folder, add its `CLAUDE.md` in the same change.

## CLI Philosophy

- `spawnfile compile` should be the primary happy path.
- The CLI should stay thin. Business logic belongs in compiler modules, not command handlers.
- The compiler should operate on resolved graph data, not raw YAML, after load and validation.

## Commits

- Use conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
- Never add co-author attributions, sign-off lines, or AI credit to commits. No `Co-Authored-By`, no `Signed-off-by`, no mentions of AI tools in commit messages.
