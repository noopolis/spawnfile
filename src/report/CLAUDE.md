# Report Guide

This folder owns compile diagnostics and report serialization.

## Structure

```text
src/report/
├── index.ts               # Barrel for report APIs
├── types.ts               # Diagnostic and compile report types
├── createDiagnostic.ts    # Diagnostic factory helpers
├── createReport.ts        # Compile report construction
├── writeReport.ts         # Report persistence to disk
└── createReport.test.ts   # Report tests
```

The compiler should hand resolved facts into this folder. This folder should not know how manifests are loaded or how adapters work internally.

## Rules

- Reports should be machine-readable and stable.
- Capability keys should stay aligned with `specs/COMPILER.md` and `specs/SPEC.md`.
- Keep report formatting separate from compiler orchestration.
