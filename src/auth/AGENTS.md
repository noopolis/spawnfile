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
├── targetSecretSourceFsIdentity.ts
│                       # Shared stat-identity model for the target-secret store:
│                       # `FileIdentity`/`DirectoryIdentity` plus the four comparators
│                       # the filesystem read and publish paths both use
├── targetSecretSource*.ts
│                       # Target-secret source records, publish/read paths, and lifecycle
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
- Every filesystem path into that store re-observes a pathname it already stat'ed, and it must decide
  sameness through `targetSecretSourceFsIdentity.ts` — never through a locally defined comparator.
  One store gets one identity model; two models mean the weaker one silently wins somewhere.
  `birthtimeNs` belongs in every comparator (it survives inode-number reuse); `ctimeNs` belongs in
  `sameFileExact` alone, because a cooperating publisher legitimately mutates a growing final and the
  publisher itself mutates directory ctime.
- `derived-config.content` is DECLARATIVE, non-secret configuration that the caller authored into the request by design —
  it is stored as a target secret for uniform handling, but it is not minted material and its presence in the caller's
  own request file is not a leak.
