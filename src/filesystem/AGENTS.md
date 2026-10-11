# Filesystem Guide

This folder owns file IO helpers and path normalization.

## Structure

```text
src/filesystem/
├── index.ts         # Barrel for filesystem helpers
├── io.ts            # Read/write/remove/ensure directory helpers
├── paths.ts         # Path validation and Spawnfile path resolution
├── retainedJsonl.ts # Locked append/fsync and atomic retention for recording logs; tolerant reads
├── durableWrite.ts  # Private file fsync, atomic rename, then parent-directory fsync
├── io.test.ts       # IO helper tests
└── paths.test.ts    # Path helper tests
```

This folder is the only place that should know about raw filesystem mechanics unless a runtime adapter truly needs something special.

## Rules

- Keep IO helpers small and explicit.
- Path normalization should be centralized here.
- Avoid sprinkling raw `fs` logic throughout the compiler.
- Recording log callers hold their domain writer lock through append and pruning.
  Sync the directory after log creation and prune renames.
  Keep the newest state at/before the retention cutoff; preserve corrupt lines for reporting.
  Interval-history callers may supply retention that also preserves the state restored
  after a rollback; ordinary point histories retain the default cutoff predecessor.
