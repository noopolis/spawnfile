# Repository scripts

These are maintained build, verification, and explicit development tools.
The compiler and installed CLI live in `src/`; this directory is not shipped
in the npm package. Scripts run as native TypeScript on Node 22.19+.

| Entrypoint | Caller | Purpose / prerequisites |
| --- | --- | --- |
| `build-local-daimon-runtime.ts` | `npm run build:local-daimon` | Build a locally sourced runtime; explicit artifact pins, Docker, and loopback registry required |
| `build-local-moltnet.ts` | `npm run build:local-moltnet` | Build and stamp release binaries from an explicit source checkout |
| `create-source-provenance-bundle.ts` | `npm run bundle:source-provenance` | Create deterministic archives with manifests and credential exclusions |
| `create-linux-amd64-dependency-closure.ts` | `npm run prepare:linux-amd64-closure` | Prepare reviewed npm dependencies/cache in the pinned build container |
| `create-linux-amd64-go-closure.ts` | `npm run prepare:linux-amd64-go-closure` | Prepare the pinned Go module-cache closure |
| `compile-explicit-test-mcp.ts` | `npm run compile:explicit-test-mcp` | Lower bounded test MCP declarations against a compiled report; build the CLI first |
| `verify-package-closure.ts` | `npm run verify:package-closure` | Verify the packed CLI and runtime closure |
| `product-state-volume-integration.test.ts` | `npm run test:product-state-volume`, CI | Test real volume preseed; Docker and host volume access required |
| `source-provenance-bundle.integration.test.ts` | `npm run test:source-provenance-docker` | Test the real offline Daimon archive build |
| `moltnet-source-provenance.integration.test.ts` | `npm run test:moltnet-source-provenance-docker` | Test the real offline Moltnet archive build |

`source-provenance-bundle.ts` and `native-helper-artifacts.ts` are shared
modules imported by these entrypoints and the native artifact copy step.
Adjacent unit tests run through `npm run test:scripts`; native artifact and
syscall integration tests also run explicitly in CI.

`npm run typecheck` checks every maintained script with strict TypeScript.
`npm test` includes script unit tests. Docker integration tests have separate
commands so unit runs never launch deployments or consume provider tokens.

The root registries are production package inputs:
[`runtimes.yaml`](../runtimes.yaml) pins runtime versions/images and
[`moltnet-releases.json`](../moltnet-releases.json) pins architecture-specific
Moltnet release assets and checksums. Their loaders and npm packaging expect
them at the package root.

Retired worktree/burnlist tooling is preserved in the [archive](../archive/).
