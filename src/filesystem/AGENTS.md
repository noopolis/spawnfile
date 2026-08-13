# Filesystem Guide

This folder owns file IO helpers and path normalization.

## Structure

```text
src/filesystem/
├── index.ts         # Barrel for filesystem helpers
├── io.ts            # Read/write/remove/ensure directory helpers
├── paths.ts         # Path validation and Spawnfile path resolution
├── io.test.ts       # IO helper tests
└── paths.test.ts    # Path helper tests
```

This folder is the only place that should know about raw filesystem mechanics unless a runtime adapter truly needs something special.

## Rules

- Keep IO helpers small and explicit.
- Path normalization should be centralized here.
- Avoid sprinkling raw `fs` logic throughout the compiler.
