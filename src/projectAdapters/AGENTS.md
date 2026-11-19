# Project Adapters Guide

This folder owns runtime adapter modules that a root Spawnfile declares in its
`adapters` map, and the operator approval that gates loading them.

## Structure

```text
src/projectAdapters/
├── index.ts               # Barrel
├── declarations.ts        # Read the root `adapters` map as data (realpath manifest, sorted entries)
├── trustStore.ts          # Operator approvals under SPAWNFILE_HOME/trust/runtime-adapters, one record per canonical manifest path
└── loadProjectAdapters.ts # Trust gate, confined module resolution, import and name checks
```

## Rules

- Declarations are data. Reading or approving them never imports module code.
- Every refusal that does not depend on the module itself (built-in names, missing or
  stale approval, escaping or unresolvable paths) happens before any declared module is
  evaluated.
- Approval covers one canonical manifest path and its exact sorted name/specifier list.
  It does not pin module content: editing an approved module or its dependencies is
  trusted, changing the declaration is not.
- Trust records must be operator-owned regular files outside the project. Project files,
  compile outputs and deployment reports never grant trust.
- Only the CLI project-command hook and explicit programmatic callers load declarations;
  nothing here auto-imports globally or reads paths named by reports.
