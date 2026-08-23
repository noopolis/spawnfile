# Scripts Guide

## Structure

~~~text
scripts/
├── AGENTS.md                    # Structure and local constraints for repository scripts
├── CLAUDE.md                    # Compatibility symlink to AGENTS.md
├── bootstrap-worktree.mjs       # Dependency-free create, check, list, and smoke CLI
├── bootstrap-worktree.test.mjs  # Bare node:test coverage and bootstrap self-test gate
├── build-closure.mjs            # Builds a selected repository dependency closure in order
├── build-closure.test.mjs       # Injected-registry and injected-run closure tests
├── build-local-daimon-runtime.mjs # Builds a digest-bound generic local Daimon image
├── build-local-moltnet.mjs      # Builds and stamps a local Moltnet release through Go
├── loop-verify.mjs              # Runs mechanical loop gates and summarizes suite failures
├── loop-verify.test.mjs         # Tests loop verification freshness and TAP parsing helpers
├── tap-self-test.mjs            # Shared TAP parsing, test discovery, and case assertions
└── worktree-bootstrap/
    ├── AGENTS.md                # Structure and constraints for bootstrap implementation modules
    ├── CLAUDE.md                # Compatibility symlink to AGENTS.md
    ├── create.mjs               # Creates nested, branch, and detached git worktrees
    ├── install.mjs              # Makes source hooks effective, clone-verifies dependencies, and inherits inputs
    ├── receipt.mjs              # Writes and validates bootstrap provenance receipts
    ├── repos.mjs                # Six-repository registry, install targets, and smoke commands
    └── verify.mjs               # Non-vacuous environment and npm-install verification
~~~

## Local design constraints

- Keep scripts on plain Node.js 22 ESM with zero third-party imports; use only node builtins and sibling modules.
- Use named exports only and keep every source file below 400 lines.
- Clone node_modules with APFS clonefile, verify it against the worktree lock, and fall back to npm ci on any defect; never symlink it.
- Preserve absolute paths and the literal WORKTREE prefix in bootstrap diagnostics.
- Hook-bearing source repositories are discovered from their source `.githooks/` directory. Bootstrap copies missing hook directories as regular files, records the action, and verifies the target worktree's existing `core.hooksPath` without mutating shared git config.
- bootstrap-worktree.test.mjs must run under bare node --test. Nothing else globs tests under scripts, so bootstrap-worktree.mjs runs it as its own non-vacuous self-test gate.
