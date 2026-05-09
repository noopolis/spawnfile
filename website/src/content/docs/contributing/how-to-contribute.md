---
title: How to Contribute
description: Ways to contribute to Spawnfile.
---

Spawnfile is fully open source under the MIT license. Contributions and discussion are welcome on [GitHub](https://github.com/noopolis/spawnfile).

## Ways to Contribute

- **Spec improvements** -- propose changes to the Spawnfile specification
- **Runtime adapters** -- add support for new autonomous agent runtimes
- **Compiler features** -- improve the compilation pipeline
- **Fixtures** -- add test cases and example projects
- **Documentation** -- improve guides, references, and research notes
- **Bug reports** -- file issues for anything that doesn't work as expected

## Getting Started

1. Fork the repository
2. Clone your fork
3. Install dependencies: `npm install`
4. Run checks: `npm run typecheck`, `npm test`, and `npm run coverage`
5. Make your changes
6. Submit a pull request

## Verification

Run the checks that match the change:

```bash
npm run typecheck
npm test
npm run coverage
npm run build
```

For runtime or container changes, also run the relevant E2E scripts:

```bash
npm run test:e2e:docker-auth
npm run test:e2e:moltnet-team-chat
npm run test:e2e:operational-smoke
```

`test:e2e:operational-smoke` runs `spawnfile up` against a real Docker
container and verifies a scheduled TinyClaw agent, managed Moltnet attachment,
and workspace resource links inside the running container. It does not require
model credentials.

For website or normative docs changes, build the docs site:

```bash
cd website
npm run build
```

When a normative spec in `specs/` changes, update the matching page under `website/src/content/docs/spec/` in the same change.

## Discussion

Open an issue or discussion on GitHub for questions, proposals, or ideas.
