# Runtime Guide

This folder owns runtime adapters and runtime option validation.

## Structure

```text
src/runtime/
├── index.ts               # Barrel for adapter registry exports
├── types.ts               # Shared adapter contract types
├── common.ts              # Shared lowering helpers used by adapters
├── registry.ts            # Bundled adapter registration and lookup
├── openclaw/              # OpenClaw adapter implementation
├── picoclaw/              # PicoClaw adapter implementation
├── tinyclaw/              # TinyClaw adapter implementation
├── common.test.ts         # Shared runtime helper tests
└── registry.test.ts       # Adapter registry tests
```

Adapter-specific behavior belongs in the runtime subfolders. `common.ts` should only hold logic that is truly shared across adapters.

## Rules

- Adapters receive resolved nodes, not raw manifests.
- Keep runtime-specific behavior isolated here.
- Share only the adapter contract, not runtime-specific implementation details.
