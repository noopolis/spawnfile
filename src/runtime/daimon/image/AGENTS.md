# Daimon runtime image

This directory owns the Docker recipes and native build scripts for the generic Daimon runtime image.

- `Dockerfile` consumes the named `daimon_package` context and verifies the capability receipt, exact executable pins, and broker.
- `SourceBundle.Dockerfile` builds an offline Daimon package from attested source and dependency archives.
- `build.json` registers the adapter's source-only local builder and publisher with the repository image catalog.
- `buildLocalRuntime.ts` creates the loopback-only development identity from a packaged checkout or offline bundle.
- `publishRuntime.ts` and `publishInputs.ts` pin the release package, tool bytes, per-platform immutable image digests, and final index identity.

Keep immutable publication checks and the clean-git and offline source authorities intact. The GitHub workflow owns publish policy and credentials. These repository tools are typechecked by the scripts project and are never imported by the compiler.
