# Compiler Guide

This folder owns graph resolution, effective configuration, compile planning, and output emission.

## Structure

```text
src/compiler/
├── index.ts                    # Barrel for compiler-facing exports
├── types.ts                    # Internal compiler plan and resolved-node types
├── helpers.ts                  # Deterministic helper utilities
├── surfaces.ts                 # Resolved docs, skills, and shared-surface merging
├── buildCompilePlan.ts         # Manifest graph walk and plan construction
├── compileProject.ts           # Adapter execution and output/report emission
├── runProject.ts               # `spawnfile run` docker-run planning and execution
├── initProject.ts              # `spawnfile init` scaffolding
├── *.test.ts                   # Tests next to the implementation they cover
```

`buildCompilePlan.ts` resolves the graph. `compileProject.ts` consumes that resolved plan. Do not collapse those concerns.

## Rules

- Keep the compiler deterministic.
- Resolve and validate the graph before calling any runtime adapter.
- The compile plan is internal state, not user-authored schema.
- Emit stable output paths and reports.
