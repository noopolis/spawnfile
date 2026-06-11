# Compiler Guide

This folder owns graph resolution, effective configuration, compile planning, and output emission.

## Structure

```text
src/compiler/
├── index.ts                    # Barrel for compiler-facing exports
├── types.ts                    # Internal compiler plan and resolved-node types
├── helpers.ts                  # Deterministic helper utilities
├── compilePlanHelpers.ts       # Fingerprints and shared validation used by graph resolution
├── agentSurfaces.ts            # Portable agent-surface resolution helpers
├── interactiveSurfaceScopes.ts # Shared helpers for runtime validation of interactive surface scope counts
├── surfaceDefinitions.ts       # Shared surface-edit command types and manifest-shape helpers
├── surfaceSupport.ts           # Runtime surface compatibility checks during graph resolution
├── surfaces.ts                 # Resolved docs, skills, and shared-surface merging
├── buildCompilePlan.ts         # Manifest graph walk and plan construction
├── buildCompilePlanTraversal.ts # Graph traversal + recursion by manifest kind
├── buildCompilePlanTraversalHelpers.ts # Shared traversal helper primitives
├── compileProject.ts           # Adapter execution and output/report emission
├── compileProjectSupport.ts    # Shared compile-time artifact injection and file writing helpers
├── containerTargetResources.ts # Per-runtime workspace resource placement for container targets
├── teamRoster.ts               # Context-scoped team roster generation and diagnostics
├── runProject.ts               # `spawnfile run` docker-run planning and execution
├── runProjectDocker.ts         # Docker run process runner and detached container metadata capture
├── initProject.ts              # `spawnfile init` orchestration around runtime-owned scaffolds
├── addProjectNode.ts           # `spawnfile add ...` graph-editing helpers
├── updateProjectModels.ts      # `spawnfile model ...` manifest-editing helpers
├── updateProjectRuntime.ts     # `spawnfile runtime ...` manifest-editing helpers
├── updateProjectSurfaces.ts    # `spawnfile surface ...` manifest-editing helpers
├── executionDefaults.ts        # Effective execution defaults applied during graph resolution
├── moltnetRoomMemberships.ts   # Pure concrete Moltnet room membership projection
├── moltnetClientConfig.ts      # Moltnet client config emission and runtime workspace layout helpers
├── moltnetNodeConfig.ts        # Moltnet node/bridge config JSON rendering helpers
├── moltnetRoomPolicyCompatibility.ts # Duplicate Moltnet network/room compatibility checks
├── moltnetBinaries.ts          # Compiled Moltnet CLI/release discovery and binary staging
├── view/                       # Pure compiler view models/renderers for `spawnfile view`
├── *.test.ts                   # Tests next to the implementation they cover
```

`buildCompilePlan.ts` resolves the graph. `compileProject.ts` consumes that resolved plan. Do not collapse those concerns.

## Rules

- Keep the compiler deterministic.
- Resolve and validate the graph before calling any runtime adapter.
- The compile plan is internal state, not user-authored schema.
- Emit stable output paths and reports.
- Keep Spawnfile as a compiler/canonicalizer: do not add custom team routers, team-message tools, or runtime RPC mechanisms.
- Treat spawned runtimes as write-only. Generated files/config/secrets may be written, but runtime state must not be read back to infer identity or update rosters.
- Team contexts are emitted as generated artifacts (`.spawnfile/team-contexts/*`, `.spawnfile/rosters/*`, `.spawnfile/team-contexts.yaml`, `.spawnfile/team-contexts.md`) and surfaced through runtime system-instruction placement when available.
- Keep runtime-specific init scaffolds in `src/runtime/<name>/`, not here.
