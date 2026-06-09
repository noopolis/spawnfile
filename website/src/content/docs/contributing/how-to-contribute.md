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

E2E scripts that expect live agent replies, such as `test:e2e:moltnet-team-chat`,
must run with runtime/model credentials injected through `spawnfile auth sync`,
`--auth-profile`, or the script's default auth-sync path. A run where Moltnet
rooms attach but agents never answer is usually an auth/profile setup failure,
not enough evidence by itself that Moltnet routing or container compilation is
broken.

For `test:e2e:moltnet-team-chat`, verify the selected profile imports Codex
credentials before treating the live reply check as meaningful:

```bash
spawnfile auth sync fixtures/e2e/moltnet-team-chat --profile e2e
```

The output should include `imports: codex`.

`test:e2e:operational-smoke` runs `spawnfile up` against a real Docker
container and verifies a scheduled PicoClaw agent, managed Moltnet attachment,
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
