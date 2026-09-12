# Scripts Guide

Maintained repository tooling lives here. [README.md](README.md) records each
entrypoint, its callers, and prerequisites. Historical worktree and burnlist
tools live in `../archive/legacy-worktree-tools/` and are not active helpers.

## Rules

- Write TypeScript with named exports, strict types, and erasable syntax. Keep
  each source file below 400 lines. Do not bypass checking with broad `any` or
  `@ts-nocheck`.
- Run source scripts with Node 22.19+ and `--experimental-strip-types`.
  `npm run typecheck` checks `scripts/tsconfig.json` and product source.
- Use Node builtins and local modules. Runtime JavaScript generated for a
  container remains an output artifact, not another script implementation.
- Keep tests next to their source. Add ordinary tests to `test:scripts`;
  real Docker or provider operations must remain explicit opt-in commands.
- Every entrypoint needs a documented caller and purpose. One-off audit dumps
  and task-specific automation do not belong here.
- Scripts must not read, print, or embed provider credential contents.

## Local runtime builds

- Daimon builds accept only explicit versions, credential-free HTTPS URLs, and
  executable/archive digest pins. Reject URLs with credentials, queries, or
  fragments before Docker runs.
- The local builder pushes only to the fixed loopback development repository.
  Its generated immutable manifest/receipt identity is ignored and never
  edits `runtimes.yaml`. Clean-source builds select the native Docker
  architecture unless an explicit supported architecture is supplied.
- Clean Git remains the default source mode. Explicit Daimon archive mode
  requires `SPAWNFILE_DAIMON_SOURCE_BUNDLE` and
  `SPAWNFILE_DAIMON_DEPENDENCY_BUNDLE`. Strict deterministic USTAR archives bind
  source, lockfile, package archives, and npm cache. Dependency preparation is
  pinned to `linux/amd64`; Docker verifies those bytes and installs offline.
- Moltnet archive mode requires source and Go dependency provenance archives.
  Its pinned Go build verifies the graph and runs with `GOPROXY=off` and
  Docker `--network=none`.
- Run the relevant network-disabled Docker provenance gate when changing
  archive content, Docker staging, dependency installation, or builder behavior.
