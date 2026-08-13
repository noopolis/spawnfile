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
- Host-local auth-owned secret state lives under `auth/target-secrets` and is keyed by immutable ids in fixed leaves:
  `versions`, `grants`, `redemptions`, `revocations`, and `aliases`.
- Path helpers for target secrets must be directory-rooted and direct-keyed only; no listing helpers.
- `derived-config.content` is DECLARATIVE, non-secret configuration that the caller authored into the request by design —
  it is stored as a target secret for uniform handling, but it is not minted material and its presence in the caller's
  own request file is not a leak.
