# Compiler View Guide

This folder owns pure compiler-facing view models and renderers for future `spawnfile view` output.

## Structure

```text
src/compiler/view/
├── index.ts                  # Barrel for view exports
├── types.ts                  # View model and renderer option types
├── declarations.ts           # Manifest-to-view declared details projection
├── buildOrganizationView.ts  # Compile-plan to organization-view projection
├── renderTree.ts             # Pure organization tree renderer
├── renderNetworks.ts         # Pure Moltnet network renderer
└── *.test.ts                 # Tests next to the renderer/model code
```

## Rules

- Keep this layer read-only over compiler plans.
- Do not import CLI modules here.
- Keep renderers pure: all filesystem and manifest loading belongs in `buildOrganizationView`.
- Prefer stable ordering and deterministic text so CLI snapshots stay reviewable.
- Keep declared agent details broad enough for `spawnfile status`: docs, skills, resources, packages, MCP servers, model, schedule, surfaces, and policy.
- Runtime entries are grouped by runtime name and should only contain stable node ids.
