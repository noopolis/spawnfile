# OpenClaw Adapter Guide

This folder owns the OpenClaw runtime adapter.

## Structure

```text
src/runtime/openclaw/
├── adapter.ts        # OpenClaw lowering and capability reporting
├── runAuth.ts        # OpenClaw runtime-auth preparation for `spawnfile run`
├── scaffold.ts       # OpenClaw-owned `spawnfile init --runtime openclaw` scaffold
├── scaffold-assets/  # Bundled OpenClaw starter docs copied into dist at build time
└── adapter.test.ts   # OpenClaw adapter tests
```

Keep the emitted structure obvious and faithful to what OpenClaw expects. If lowering is approximate, say so in the capability report instead of hiding it.

## Rules

- Prefer emitting obvious OpenClaw workspace structure over clever abstraction.
- Keep capability reporting explicit when a feature maps only approximately.
