# Shared Guide

This folder owns small cross-cutting helpers and shared value types.

## Structure

```text
src/shared/
├── index.ts         # Barrel for shared exports
├── constants.ts     # Small shared constants
├── errors.ts        # Typed error helpers and guards
├── types.ts         # Cross-cutting shared types
└── errors.test.ts   # Shared error tests
```

Only put code here when more than one area genuinely depends on it. Otherwise keep it local.

## Rules

- Do not turn this into a dumping ground.
- Shared utilities should stay generic and side-effect free.
- If a helper is only used in one area, keep it local to that area instead.
