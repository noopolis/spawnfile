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
├── compileProject.ts           # Adapter execution and output/report emission
├── compileProjectSupport.ts    # Shared compile-time artifact injection and file writing helpers
├── runProject.ts               # `spawnfile run` docker-run planning and execution
├── initProject.ts              # `spawnfile init` orchestration around runtime-owned scaffolds
├── addProjectNode.ts           # `spawnfile add ...` graph-editing helpers
├── updateProjectModels.ts      # `spawnfile model ...` manifest-editing helpers
├── updateProjectRuntime.ts     # `spawnfile runtime ...` manifest-editing helpers
├── updateProjectSurfaces.ts    # `spawnfile surface ...` manifest-editing helpers
├── executionDefaults.ts        # Effective execution defaults applied during graph resolution
├── surfaceRouter.ts              # Surface router script and config generation for team routing
├── moltnetClientConfig.ts      # Moltnet client config emission and runtime workspace layout helpers
├── moltnetBinaries.ts          # Compiled Moltnet CLI/release discovery and binary staging
├── *.test.ts                   # Tests next to the implementation they cover
```

`buildCompilePlan.ts` resolves the graph. `compileProject.ts` consumes that resolved plan. Do not collapse those concerns.

## Rules

- Keep the compiler deterministic.
- Resolve and validate the graph before calling any runtime adapter.
- The compile plan is internal state, not user-authored schema.
- Emit stable output paths and reports.
- Keep runtime-specific init scaffolds in `src/runtime/<name>/`, not here.
