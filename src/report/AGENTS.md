# Report Guide

This folder owns compile diagnostics and report serialization.

## Structure

```text
src/report/
├── index.ts               # Barrel for report APIs
├── types.ts               # Diagnostic and compile report types
├── recording.ts           # Portable deployed recording facts and shared strict schemas
├── createDiagnostic.ts    # Diagnostic factory helpers
├── createReport.ts        # Compile report construction
├── writeReport.ts         # Report persistence to disk
└── createReport.test.ts   # Report tests
```

The compiler should hand resolved facts into this folder. This folder should not know how manifests are loaded or how adapters work internally.

## Rules

- Reports should be machine-readable and stable.
- Optional `recording` carries the maximum recording window, protected memory/recording mount IDs,
  and per-agent facts for sync. The same schema validates distribution and deployment records.
  Workspace git/bundle report IDs name the resources agents see. Each pin retains
  `agent_node_ids` and `declared_by` from compilation only when recording is on;
  history and distribution reuse them. Off preserves the legacy pin shape and deduplication.
- Capability keys should stay aligned with `specs/COMPILER.md` and `specs/SPEC.md`.
- Keep report formatting separate from compiler orchestration.
- Runtime `agent_paths` carries adapter-owned workspace/home/skill roots for shared instances. Moltnet node plans carry `node_id`, preserving attachment identity independently of member aliases.
