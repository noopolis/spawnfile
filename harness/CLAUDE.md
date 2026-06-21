# Harness Package Guide

This folder is a local incubation package for a reusable Noopolis harness.

It must stay detached from the Spawnfile compiler implementation. Spawnfile owns
teams, org graphs, Moltnet wiring, schedules, workspace compilation, and
deployment. This package owns only the per-agent harness boundary.

## Structure

- `src/core/` defines per-agent harness contracts.
- `src/pi/` implements the contract using Pi's SDK.
- `src/examples/` contains runnable local examples and E2E checks.

## Rules

- Keep runtime credentials out of git. Generated runtime state belongs under
  `.runtime/`, which is ignored.
- Keep teams/orgs out of this package. A caller may start many harnessed agents,
  but the harness API should only know about one agent at a time.
- Keep the public contract independent of Pi-specific types.
- Pi-specific logic belongs under `src/pi/`.
- Examples should be runnable with `npm run e2e:pi-agent`.
