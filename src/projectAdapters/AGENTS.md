# Project Adapters Guide

This folder loads the runtime adapters declared in the root Spawnfile.

## Structure

- `declarations.ts` reads the root manifest and sorts its `adapters` entries by runtime name.
- `loadProjectAdapters.ts` resolves and imports those modules and checks their exported names.
- `index.ts` exports the declaration reader and loaders.

## Rules

- Each source project command loads the current root declarations. An explicit `--adapter` takes precedence for its runtime name.
- Resolve local modules inside the project and package names from the project's installed dependencies. Check bundled names and resolve the module paths before evaluating any declared module.
- Keep registration scoped to the invocation. Reports and compile outputs describe the selected runtimes. Module entrypoints come from the source project or CLI.
