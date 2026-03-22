# Auth Guide

This folder owns Spawnfile-managed auth profiles and auth import flows.

## Structure

```text
src/auth/
├── index.ts            # Barrel exports
├── types.ts            # Auth profile types
├── paths.ts            # Spawnfile auth home and profile path helpers
├── profileStore.ts     # Read/write auth profiles and imported auth material
├── importers.ts        # `.env`, Codex, and Claude Code import flows
└── *.test.ts           # Tests next to the implementation they cover
```

## Rules

- Keep auth profile storage separate from compiler output.
- Auth profiles are local operational state, not project source.
- Do not bake secrets into generated images by default.
- Prefer explicit logical auth imports over runtime-specific ad hoc copying.
