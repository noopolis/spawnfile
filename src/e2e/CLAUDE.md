# E2E Guide

This folder owns opt-in end-to-end validation flows that need Docker and real credentials.

## Structure

```text
src/e2e/
├── cli.ts              # Opt-in E2E entrypoint used by npm scripts
├── dockerAuth.ts       # Docker build/run orchestration for auth smoke scenarios
├── fixtures.ts         # Temporary project materialization from e2e fixtures
├── operationalSmoke.ts # spawnfile up smoke for schedules, Moltnet, and workspace resources
├── runtimePrompts.ts   # Runtime-specific readiness and prompt checks
├── scenarios.ts        # Supported E2E scenario matrix
└── *.test.ts           # Pure tests for fixture/scenario logic
```

## Rules

- Keep Docker/process orchestration here, not in compiler modules.
- Reuse compiler and auth APIs instead of shelling through the Spawnfile CLI.
- Treat these flows as opt-in developer verification, not normal unit-test coverage.
- Keep runtime-specific prompt logic obvious and isolated.
- When an E2E expects live runtime replies, inject the required runtime/model credentials through `syncProjectAuth` or an explicit auth profile before interpreting failures. Missing credentials can make bridges attach successfully while agents never answer, which is an auth/setup failure rather than a Moltnet or compiler failure.
- Before running `moltnet-team-chat`, verify the selected auth profile includes a Codex import because every OpenClaw agent in that fixture declares `execution.model.*.auth.method: codex`. A valid preflight is `spawnfile auth sync fixtures/e2e/moltnet-team-chat --profile <name>` followed by confirming the output includes `imports: codex`.
- Never run the live Moltnet team-chat E2E on ports already used by the developer. If `8787` is occupied, copy the fixture to `/tmp` and rewrite the parent and child Moltnet server ports separately; the source fixture uses `8787` in both the root team and nested field team, so a blind replacement can make both servers bind the same port.
- A known-good isolated live command is:

  ```bash
  tmp="$(mktemp -d /tmp/spawnfile-team-chat.XXXXXX)"
  cp -R fixtures/e2e/moltnet-team-chat/. "$tmp"
  perl -pi -e 's/8787/21087/g' "$tmp/Spawnfile"
  perl -pi -e 's/8787/21088/g' "$tmp/teams/field/Spawnfile"
  npm run test:e2e:moltnet-team-chat -- \
    --fixture "$tmp" \
    --parent-base-url http://127.0.0.1:21087 \
    --child-base-url http://127.0.0.1:21088 \
    --container-name spawnfile-team-chat-retry \
    --image-tag spawnfile-team-chat-retry \
    --timeout-ms 300000 \
    --poll-interval-ms 3000
  ```

- A passing live agent communication run prints `Moltnet team-chat E2E passed (...)`. This means the generated container started Moltnet, attached the bridges, woke the OpenClaw/Codex agents, and observed both the parent request/ACK and child ACK messages.
- After any interrupted live run, clean up the isolated container/image and confirm the developer's active containers are still present: `docker rm -f spawnfile-team-chat-retry || true`, `docker image rm -f spawnfile-team-chat-retry || true`, then `docker ps --format '{{.Names}} {{.Ports}}'`.
