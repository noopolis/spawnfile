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
├── build-local-daimon-runtime.mjs # Builds/pushes a receipt-bound Daimon image to an explicit loopback registry
├── build-local-daimon-runtime.test.mjs # AGY archive, provenance, redaction, and image-authority tests
├── create-source-provenance-bundle.mjs # Deterministic dirty-tree-safe all-input archive creator
├── create-linux-amd64-dependency-closure.mjs # Pinned-container lock/cache closure preparation
├── create-linux-amd64-go-closure.mjs # Pinned Go module-cache preparation for offline amd64 builds
├── source-provenance-bundle.mjs # Strict manifest, exclusion, ustar, digest, and drift checks
├── build-local-moltnet.mjs      # Builds and stamps a local Moltnet release through Go
├── compile-explicit-test-mcp.mjs # Lowers bounded test-only MCP declarations against a compiled Daimon report
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
- The local Daimon builder accepts the official AGY archive only through explicit
  version, credential-free URL, SHA-512 archive, and SHA-256 extracted-executable
  pins. It pushes only to the fixed loopback development repository and emits an
  ignored immutable manifest/receipt identity; it currently fails closed outside
  `linux/amd64` and never edits the runtime registry.
- Its public artifact inputs are `AGY_CLI_VERSION`, `AGY_CLI_URL`,
  `AGY_CLI_SHA512`, `AGY_CLI_SHA256`, `GROK_CLI_VERSION`, `GROK_CLI_URL`,
  `GROK_CLI_SHA256`, and `CODEX_CLI_SHA256`; URLs containing credentials,
  queries, or fragments are rejected before Docker is invoked.
- The unchanged default Daimon source mode requires clean Git. Explicit archive
  mode requires both `SPAWNFILE_DAIMON_SOURCE_BUNDLE` and
  `SPAWNFILE_DAIMON_DEPENDENCY_BUNDLE`; each is a strict deterministic ustar
  created by `npm run bundle:source-provenance -- <root> <output>` and
  `npm run bundle:source-provenance -- --dependencies <root> <output>`. The first
  root is the reviewed source tree; the dependency root contains exactly its
  reviewed `package.json`, package-lock v3 graph, local package archives, and
  npm cache prepared directly from the reviewed Daimon package/lock by `npm run
  prepare:linux-amd64-closure -- <absolute-daimon-source> <absolute-output>
  <exact-codex-version>`. Docker runs `npm ci --offline`, checks every installed
  package against the lock, then ships the pruned production closure. The target is always
  `linux/amd64`, including from an arm64 host; arm64 output is not supported.
  Docker verifies and consumes those exact bytes without Git metadata or npm
  registry dependency resolution. Run `npm run test:source-provenance-docker`
  for the mandatory network-disabled real-Docker archive gate.
- The unchanged local Moltnet default also requires clean Git. Dirty-tree archive
  mode requires strict `--build-source` and `--go-dependencies` provenance
  archives in `SPAWNFILE_MOLTNET_SOURCE_BUNDLE` and
  `SPAWNFILE_MOLTNET_GO_DEPENDENCY_BUNDLE`. Prepare the latter with
  `npm run prepare:linux-amd64-go-closure -- <absolute-source> <absolute-output>`.
  The pinned Go container verifies the module graph twice, the final build uses
  `GOPROXY=off` and Docker `--network=none`, and the local stamp binds both
  archive identities and the toolchain digest.
- Clone node_modules with APFS clonefile, verify it against the worktree lock, and fall back to npm ci on any defect; never symlink it.
- Preserve absolute paths and the literal WORKTREE prefix in bootstrap diagnostics.
- Hook-bearing source repositories are discovered from their source `.githooks/` directory. Bootstrap copies missing hook directories as regular files, records the action, and verifies the target worktree's existing `core.hooksPath` without mutating shared git config.
- bootstrap-worktree.test.mjs must run under bare node --test. Nothing else globs tests under scripts, so bootstrap-worktree.mjs runs it as its own non-vacuous self-test gate.
