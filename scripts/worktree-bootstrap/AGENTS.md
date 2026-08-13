# Worktree Bootstrap Guide

## Structure

~~~text
worktree-bootstrap/
├── AGENTS.md   # This structure and constraints guide
├── CLAUDE.md   # Compatibility symlink to AGENTS.md
├── create.mjs  # Git worktree creation, nesting, detachment, force, and idempotency
├── install.mjs # Hook materialization, clone-verify-fallback installs, disk timings, and inherited inputs
├── receipt.mjs # Bootstrap receipt hashing, persistence, reading, and item validation
├── repos.mjs   # Repository paths, install targets, test suites, and smoke commands
└── verify.mjs  # Symlink, npm receipt, git worktree, asset, and nesting assertions
~~~

## Local design constraints

- Use dependency-free Node.js 22 ESM and named exports only.
- Keep each file below 400 lines and keep orchestration in the parent CLI.
- Verification must be non-vacuous, collect every defect, and prefix every diagnostic with WORKTREE plus an absolute path.
- Clone dependencies with clonefile, accept them only after exact worktree-lock verification, and fall back to npm ci when reuse is stale or incomplete.
- Never create, accept, or follow a symlinked node_modules path.
- Hook wiring is resolved from each worktree's own `core.hooksPath`; never set it from bootstrap because git config is shared by linked worktrees. Missing source `.githooks/` directories are copied as regular directories and their actions are recorded in the root bootstrap receipt.
