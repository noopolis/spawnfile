# Spawnfile Working Guide

This repository is the reference implementation of the Spawnfile v0.1 compiler.

## Repository Structure

```text
.
├── README.md                 # Project overview and install/use flow
├── runtimes.yaml             # Runtime registry — pinned versions and status
├── moltnet-releases.json     # Pinned, checksum-verified Moltnet release authority
├── blueprints/               # Frozen reference layouts per runtime at pinned version
├── specs/                    # Specs, architecture docs, and runtime research
├── scripts/                  # Bootstrap and repo helper scripts
├── src/                      # CLI, compiler, adapters, manifests, reports, target contracts
├── runtime-images/           # Dockerfiles for packaged runtime images
│                             # (openclaw, picoclaw, daimon)
├── examples/                 # Showcase Spawnfile org projects (reference layouts)
├── fixtures/                 # Test-only Spawnfile org projects + support/ helpers
├── website/                  # Documentation site (Astro)
├── .github/                  # CI workflows (tests, runtime-images, publish)
├── package.json              # Node package metadata and CLI scripts
├── tsconfig.json             # Typecheck config
├── tsconfig.build.json       # Build-only emit config
└── vitest.config.ts          # Test and coverage configuration
```

`src/` is the implementation root. Every subfolder there should explain its own local structure in a nested `AGENTS.md`.

## General Rules

- Keep the implementation aligned with the normative specs: `specs/SPEC.md`, `specs/COMPILER.md`, `specs/CONTAINERS.md`, and `specs/RUNTIMES.md`.
- Prefer small, composable modules with explicit responsibilities.
- Do not allow source files to grow past 400 lines. Split early when files start creeping up.
- Use named exports only. Do not introduce default exports.
- Use barrel exports for folder entry points.
- Keep test files next to the files they cover: `file.ts` and `file.test.ts`.
- Aim for 90% or better coverage.
- For live Docker E2E work, read `src/e2e/AGENTS.md` first. Do not reuse a developer's active Moltnet port; run isolated fixtures on alternate ports and inject real runtime auth before judging agent communication.
- Do not reinvent well-understood workflows when a stable precedent exists. Learn from Docker-style ergonomics where it helps.

## Folder Rules

- Every implementation folder must have its own nested `AGENTS.md` and a compatibility `CLAUDE.md` symlink pointing to it.
- Nested guides should describe the structure of that area, what each file is for, and any local design constraints.
- When creating a new implementation folder, add its `AGENTS.md` and `CLAUDE.md` symlink in the same change.

## CLI Philosophy

- `spawnfile compile` should be the primary happy path.
- The CLI should stay thin. Business logic belongs in compiler modules, not command handlers.
- The compiler should operate on resolved graph data, not raw YAML, after load and validation.

## Branches and pull requests

**Never commit to `main`.** Every change lands through a pull request, without
exception — including one-line fixes, CI configuration, documentation, and
version bumps. Work on a branch, push it, open the PR, and let CI run.

Direct commits to `main` bypass the checks that catch what local runs do not.
A zero-byte receipt store, a package that ships without its native binary, and
a two-week-red pipeline all reached `main` in this ecosystem while every local
gate was green — CI found them the first time it ran over the code.

- Branch names describe the change: `feat/…`, `fix/…`, `ci/…`, `docs/…`.
- Commit messages are conventional and single-line (`feat:`, `fix:`, `docs:`,
  `ci:`, `chore:`, `refactor:`, `test:`).
- Never add co-author lines, sign-offs, or AI attributions.
- Commit as you go rather than in one batch at the end, so history shows how
  the work progressed.
- Merge with a merge commit rather than a squash when the individual commits
  carry meaning; squashing collapses that history irreversibly.
