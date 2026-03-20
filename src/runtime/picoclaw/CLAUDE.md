# PicoClaw Adapter Guide

This folder owns the PicoClaw runtime adapter.

## Structure

```text
src/runtime/picoclaw/
├── adapter.ts        # PicoClaw lowering and runtime-option validation
└── adapter.test.ts   # PicoClaw adapter tests
```

This adapter is a strong overlap target for docs, skills, MCP, and workspace intent, so keep its mappings clear and predictable.

## Rules

- Preserve PicoClaw's workspace-first model.
- Keep MCP lowering faithful because PicoClaw is a strong MCP target.
