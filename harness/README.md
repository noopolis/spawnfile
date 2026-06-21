# Noopolis Harness

Local incubation package for a reusable agent harness.

This package is intentionally detached from the Spawnfile compiler. It defines a
small per-agent harness contract and proves that Pi can run one harnessed agent
inside a caller-prepared workspace.

Spawnfile should own orgs, nested teams, schedules, Moltnet wiring, workspace
resource compilation, and the app that starts many harnessed agents. This package
should not know what an org is.

## Pi E2E

The Pi E2E uses the local Codex CLI subscription auth file to seed an ignored Pi
`auth.json` under `.runtime/`.

```bash
cd harness
npm install
npm run e2e:pi-agent
```

The example starts two harnessed Pi agents from plain caller code. The example
creates the workspaces and shared resource itself to demonstrate the intended
boundary: the caller prepares files, the harness runs agent turns.
