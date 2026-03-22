# E2E Guide

This folder owns opt-in end-to-end validation flows that need Docker and real credentials.

## Structure

```text
src/e2e/
├── cli.ts              # Opt-in E2E entrypoint used by npm scripts
├── dockerAuth.ts       # Docker build/run orchestration for auth smoke scenarios
├── fixtures.ts         # Temporary project materialization from e2e fixtures
├── runtimePrompts.ts   # Runtime-specific readiness and prompt checks
├── scenarios.ts        # Supported E2E scenario matrix
└── *.test.ts           # Pure tests for fixture/scenario logic
```

## Rules

- Keep Docker/process orchestration here, not in compiler modules.
- Reuse compiler and auth APIs instead of shelling through the Spawnfile CLI.
- Treat these flows as opt-in developer verification, not normal unit-test coverage.
- Keep runtime-specific prompt logic obvious and isolated.
