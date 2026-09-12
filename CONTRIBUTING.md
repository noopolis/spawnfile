# Contributing

## Prerequisites

- Node 22.19+ (including native TypeScript script execution)
- Docker if you want to run the `spawnfile build` end-to-end test against a real image

## Local Workflow

Clone and link the CLI locally:

```bash
git clone https://github.com/noopolis/spawnfile.git
cd spawnfile
nvm use
npm install
npm run build
npm link
```

Run the core checks before opening a change:

```bash
npm test
npm run typecheck
```

Run the CLI on a fixture without a global link:

```bash
npm run dev -- validate fixtures/single-agent
```

## Website

```bash
cd website
npm ci
npm run build
```

## Testing

- `npm test` — compiler tests via Vitest, runtime node:test cases, and maintained script unit tests.
- `npm run coverage` — unit tests with coverage output.
- `npm run test:e2e:docker-auth` — end-to-end against a real compiled container. Needs Docker.

## Adding a runtime

Runtime adapters live in `src/runtime/`. Each adapter lowers the resolved graph into runtime-native output and reports per-capability support.

- Start from [`specs/SPEC.md`](specs/SPEC.md) to understand the source shape.
- Read [`specs/COMPILER.md`](specs/COMPILER.md) for the adapter contract.
- Check [`specs/RUNTIMES.md`](specs/RUNTIMES.md) for the live matrix and pinned versions.
- Use [`blueprints/`](blueprints/) as frozen reference layouts per pinned runtime version.

When adding a runtime, also update `runtimes.yaml` with the pinned version and status.

## Docs and guides

- Keep `README.md` focused on getting started.
- Put detailed specification material in `specs/`.
- Keep historical plans, reviews, and audit diagrams in `archive/`.
- Write repository scripts in TypeScript. Their purpose, callers, and checks belong in [`scripts/README.md`](scripts/README.md).
- Keep package `AGENTS.md` guides in present tense and aligned with current code, with `CLAUDE.md` symlinks for compatibility.

## Commit style

Use conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`.

Do not add co-author attributions, sign-off lines, or AI credit to commits.
