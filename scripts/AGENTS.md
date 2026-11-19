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
- Daimon builds also accept only the Grok CLI build the vendored Daimon
  contract manifest pins for the target architecture (`readPinnedGrokCli`).
- The Daimon descriptor, contract, and live-check entrypoints delegate to
  `src/runtime/daimon/image/`. Its guide records the provenance and probe rules.
- The local builder pushes only to the fixed loopback development repository.
  Its generated immutable manifest/receipt identity is ignored and never
  edits `runtimes.yaml`. Clean-source builds select the native Docker
  architecture unless an explicit supported architecture is supplied.
- `runtime-image-catalog.ts` reads static metadata under each adapter without loading runtime code.
- `publish-daimon-runtime.ts` delegates to the same adapter-owned publisher as CI. The publisher reads the
  checked-in `src/runtime/daimon/image/publish-inputs.json` (full Daimon commit,
  per-architecture AGY pins, Codex pin; Grok comes from the vendored manifest),
  refuses a packed manifest that differs from the explicit publication
  `contract_manifest_sha256` (or vendored contract for legacy inputs), and never
  moves an existing tag. Its receipts carry `mode: "ci-published"` provenance.
  A publication may precede the compiler/runtime re-pin by setting the explicit
  manifest digest alongside `daimon.commit`; the Dockerfile still validates
  contract semantics and every engine artifact pin.
  The published identity is pinned into `runtimes.yaml` by a reviewed PR, never
  written by the script.
- Clean Git remains the default source mode. Explicit Daimon archive mode
  requires `SPAWNFILE_DAIMON_SOURCE_BUNDLE` and
  `SPAWNFILE_DAIMON_DEPENDENCY_BUNDLE`. Strict deterministic USTAR archives bind
  source, lockfile, package archives, and npm cache. Dependency preparation is
  pinned to `linux/amd64`; Docker verifies those bytes and installs offline.
- To stamp an ACP-capable local Moltnet archive, set
  `SPAWNFILE_MOLTNET_ENABLE_ACP=1` when building an ACP-capable source revision.
  The builder must prove the ACP node contract before writing its capability.
  The production release pin is independent of this local opt-in.
- Moltnet archive mode requires source and Go dependency provenance archives.
  Its pinned Go build verifies the graph and runs with `GOPROXY=off` and
  Docker `--network=none`.
- Run the relevant network-disabled Docker provenance gate when changing
  archive content, Docker staging, dependency installation, or builder behavior.

