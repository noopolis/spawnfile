# CLI Guide

This folder owns user-facing command parsing and process exit behavior.

## Structure

```text
src/cli/
├── index.ts        # Executable Node entrypoint
├── runCli.ts       # Commander setup and command handlers
└── runCli.test.ts  # CLI behavior tests
```

`index.ts` should stay minimal. `runCli.ts` owns command wiring, while real work stays in compiler modules.

## Rules

- Keep command handlers small.
- Push parsing, validation, and compile behavior into compiler modules.
- Normalize errors here so the rest of the code can throw typed errors.
- Keep the CLI testable by isolating parsing from direct process exit handling.
