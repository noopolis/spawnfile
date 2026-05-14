# PicoClaw Adapter Guide

This folder owns the PicoClaw runtime adapter.

## Structure

```text
src/runtime/picoclaw/
├── adapter.ts        # PicoClaw lowering and runtime-option validation
├── runAuth.ts        # PicoClaw runtime-auth preparation for `spawnfile run`
├── schedules.ts      # PicoClaw cron schedule lowering and diagnostics
├── scaffold.ts       # PicoClaw-owned `spawnfile init --runtime picoclaw` scaffold
├── surfaces.ts       # PicoClaw surface lowering and supported-surface checks
├── scaffold-assets/  # Bundled PicoClaw starter docs copied into dist at build time
└── *.test.ts         # PicoClaw adapter, schedule, auth, and surface tests
```

This adapter is a strong overlap target for docs, skills, MCP, and workspace intent, so keep its mappings clear and predictable.

## Rules

- Preserve PicoClaw's workspace-first model.
- Keep MCP lowering faithful because PicoClaw is a strong MCP target.
- Portable HTTP is not part of the v0.1 alpha surface contract. Treat PicoClaw webhook/server behavior as runtime-specific unless a future spec reintroduces portable ingress.
- Do not add Spawnfile-owned team routing. Team context orientation should use the adapter's system-instruction surface metadata when supported.
