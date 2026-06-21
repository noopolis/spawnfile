# Daimon

Daimon is the Noopolis-native per-agent runtime harness.

It defines a small per-agent contract and currently implements that contract on
top of Pi. A Daimon runs one harnessed agent inside a caller-prepared workspace.

Spawnfile should own orgs, nested teams, schedules, Moltnet wiring, workspace
resource compilation, and the app that starts many harnessed agents. This package
should not know what an org is.

## Install

```bash
npm install @noopolis/daimon
```

## Tests

The package has a non-live test suite for auth seeding and Pi model config
generation:

```bash
npm test
npm run typecheck
npm run build
```

These tests do not call a model provider.

## Model And Auth Helpers

The Pi adapter supports the same model intent shape Spawnfile lowers for Pi:

- OpenAI Codex subscription auth maps to Pi's `openai-codex` OAuth auth store.
- Claude Code subscription auth maps to Pi's Anthropic auth store.
- API-key credentials can be written directly into Pi auth storage.
- Local and custom OpenAI-compatible endpoints render Pi `models.json`.

For Ollama-style local models, use a local endpoint with `auth.method: none`.
Pi still requires an API-key field for custom providers, so the helper writes the
upstream-documented dummy `ollama` value.

## Pi E2E

The Pi E2E uses the local Codex CLI subscription auth file to seed an ignored Pi
`auth.json` under `.runtime/`.

```bash
npm install
npm run e2e:pi-agent
```

The example starts two harnessed Pi agents from plain caller code. The example
creates the workspaces and shared resource itself to demonstrate the intended
boundary: the caller prepares files, the harness runs agent turns.
