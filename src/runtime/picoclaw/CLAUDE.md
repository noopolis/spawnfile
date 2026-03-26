# PicoClaw Adapter Guide

This folder owns the PicoClaw runtime adapter.

## Structure

```text
src/runtime/picoclaw/
├── adapter.ts        # PicoClaw lowering and runtime-option validation
├── surfaces.ts       # PicoClaw surface lowering and supported-surface checks
├── runAuth.ts        # PicoClaw runtime-auth preparation for `spawnfile run`
├── scaffold.ts       # PicoClaw-owned `spawnfile init --runtime picoclaw` scaffold
├── scaffold-assets/  # Bundled PicoClaw starter docs copied into dist at build time
└── adapter.test.ts   # PicoClaw adapter tests
```

This adapter is a strong overlap target for docs, skills, MCP, and workspace intent, so keep its mappings clear and predictable.

## Rules

- Preserve PicoClaw's workspace-first model.
- Keep MCP lowering faithful because PicoClaw is a strong MCP target.
