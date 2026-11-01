# E2E Guide

This folder owns opt-in end-to-end validation flows that need Docker and real credentials.

## Structure

```text
src/e2e/
├── cli.ts              # Opt-in E2E entrypoint used by npm scripts
├── cliMoltnet.ts       # Moltnet team-chat and memetics CLI option adapters
├── cliSmoke.ts         # Lifecycle, operational, and Daimon organization smoke CLI adapters
├── cliMemory.ts        # Memory wiring and Ollama probe CLI adapters
├── dockerAuth.ts       # Docker build/run orchestration for auth smoke scenarios
├── fixtures.ts         # Temporary project materialization from e2e fixtures
├── operationalSmoke.ts # spawnfile up smoke for schedules, Moltnet, and workspace resources
├── operationalSmokePicoclaw.ts # PicoClaw-specific operational smoke helpers
├── operationalSmokeStatus.ts # Assertions for operational spawnfile status --live JSON output
├── lifecycleSmoke.ts # spawnfile up/artifacts-export/down --json lifecycle smoke against a minimal SCRIPTED fixture — zero transcript/turn/behavior assertions (Decision 20/21, Slice B Piece 5 step 5); the coverage safety net that replaced officeSim*.ts/autonomousOfficeSim*.ts once the office-sim scenario itself migrated to ecosystem/simfile
├── memoryIntegration.ts # Compile/report memory wiring checks for Daimon, PicoClaw, and Jungian fixtures
├── memoryIntegrationSupport.ts # Shared helpers for memory integration E2Es
├── ollamaProbe.ts      # Optional local Ollama embeddings probe
├── preflight.ts        # Local readiness report surface and B18 adapter
├── preflightCli.ts     # CLI wrapper for the readiness report
├── preflightCheckers.ts # Command/path/package readiness probes used by the preflight
├── preflightCliTokenCheckers.ts # Deep token-validity probes for the grok and antigravity CLI auth stores (checkGrokAuth, checkAntigravityAuth) — split out of preflightCheckers.ts to stay under 400 lines. Unlike a bare directory-existence check, these parse the actual token file: grok's `~/.grok/auth.json` (or `$GROK_HOME`) is checked for a non-expired `expires_at` on its `https://auth.x.ai::<uuid>` entry (grok's refresh is server-rejected once fully expired, so an expired token fails outright with a "run `grok login`" remediation); antigravity's `~/.gemini/antigravity-cli/antigravity-oauth-token` (or `$ANTIGRAVITY_CLI_HOME`) is only checked for a parseable token object with a refresh token, since the agy CLI auto-refreshes an expired access token on use (verified live) — an expired access token is not itself a failure
├── preflightCompile.ts # Compile-only mixed-runtime readiness probe for Mneme/Daimon/OpenClaw/PicoClaw/Moltnet
├── preflightNetworkChecks.ts # Bounded fetch probes for Ollama embeddings and Moltnet health
├── preflightTypes.ts   # Shared preflight report/check option types and ids
├── runtimePrompts.ts   # Runtime-specific readiness and prompt checks
├── runtimePackageOverrides.ts # Explicit dependency overrides for unreleased runtime E2Es (local-rootfs `applyRuntimePackageOverrides` + `assertRuntimePackageOverrideDistsBuilt` shared by the container-build override request map)
├── scenarios.ts        # Supported E2E scenario matrix
├── moltnetWireTypes.ts # Generic Moltnet wire-protocol shapes shared by every bespoke driver (MoltnetE2ELogger, MoltnetRoom, MoltnetAgentSummary, MoltnetMessage, MoltnetApiClient), with deprecated MoltnetTeamChat*-named aliases kept for back-compat. Scenario-specific types stay next to their scenario (moltnetTeamChatTypes.ts, moltnetMemeticsTypes.ts)
├── moltnetE2ESupport.ts # Generic Docker/Moltnet boot+observe plumbing extracted out of moltnetTeamChat.ts so every driver (team-chat, memetics, lifecycle-smoke) can reuse it without depending on any one bespoke scenario module: createMoltnetHttpClient, poll/PollOptions, waitForRoom, waitForAgents, waitForRuntimeReadiness, runDockerCommand, resolveAuthProfile, cleanup, formatHistory, healthPathForRuntime, assertExactRoomMembers, and the MoltnetRoomTarget/DockerCommandRunner/MoltnetE2EDependencies types. moltnetTeamChat.ts re-imports and re-exports these — a single definition, no duplication
├── moltnetExchangeWait.ts # Generic multi-turn exchange-completion wait, split out of moltnetMemeticsExchange.ts to be scenario-agnostic (no memetics-specific naming): pure stop/continue decision (evaluateExchangeCompletion) plus the injectable-clock polling loop (waitForConversationExchange) that drives it. moltnetMemeticsExchange.ts is now a thin re-export shim over this module
├── moltnetArtifactSupport.ts # Generic docker-cp/JSONL helpers (copyContainerPathToHost, countJsonlLines), split out of moltnetMemeticsArtifacts.ts so other drivers could reuse them without depending on the bespoke memetics-transcript module. moltnetMemeticsArtifacts.ts re-imports and re-exports these — a single definition, no duplication
├── moltnetMemetics.ts # Live Eleanor<->Sam Moltnet conversation E2E over real Codex/Grok (runMoltnetMemeticsE2E)
├── moltnetMemeticsTypes.ts # Options/result/conversation types for the harness above
├── moltnetMemeticsExchange.ts # Thin re-export shim over moltnetExchangeWait.ts, kept so moltnetMemeticsExchange.test.ts keeps passing unmodified
├── moltnetMemeticsArtifacts.ts # Pure memetics-transcript rendering/serialization (agentSlugFromNodeId, resolveInstanceRoot, serializeMemeticsTranscriptJsonl, renderMemeticsTranscriptMarkdown); re-imports/re-exports copyContainerPathToHost/countJsonlLines from moltnetArtifactSupport.ts
└── *.test.ts           # Pure tests for fixture/scenario logic
```

**Retired (Slice B, Piece 5 step 6, 2026-07):** the office-sim bespoke monolith
— `officeSim.ts`/`officeSimEngines.ts`/`officeSimTypes.ts`/`officeSimSummary.ts`
(+ test) and the entire `autonomousOfficeSim*` family (orchestrator, CLI,
control-phase, fake engines, harness support, ledger, markdown, the 13
continuity probes, report writer, world/clock table, types, + tests) — is
DELETED. The composed office-sim (Spawnfile org + Simfile world, `spawnfile
up/artifacts export/down --json` driven by `ecosystem/simfile/src/sims/`) is
the proven drop-in replacement; see that package's `AGENTS.md` and
`.local/plan/decisions.md` Decision 21. `lifecycleSmoke.ts` above is what
replaces this folder's own e2e coverage of the up/export/down lifecycle.

## Rules

- Generic volume cleanup refuses recording memory before any teardown.
  Pure recording-cleanup tests inject commands; they never invoke Docker or credentials.

- Keep Docker/process orchestration here, not in compiler modules.
- Reuse compiler and auth APIs instead of shelling through the Spawnfile CLI.
- Treat these flows as opt-in developer verification, not normal unit-test coverage.
- Keep runtime-specific prompt logic obvious and isolated.
- Do not encode domain-specific simulation behavior here. Spawnfile can compile
  and run authored fixtures, but scenarios, clocks, characters, world rules,
  transcripts, and simulation reports belong to the system that defines them.
- When an E2E expects live runtime replies, inject the required runtime/model credentials through `syncProjectAuth` or an explicit auth profile before interpreting failures. Missing credentials can make bridges attach successfully while agents never answer, which is an auth/setup failure rather than a Moltnet or compiler failure.
- Before running `moltnet-team-chat`, verify the selected auth profile includes a Codex import because every OpenClaw agent in that fixture declares `execution.model.*.auth.method: codex`. A valid preflight is `spawnfile auth sync examples/moltnet-team-chat --profile <name>` followed by confirming the output includes `imports: codex`.
- Never run the live Moltnet team-chat E2E on ports already used by the developer. If `8787` is occupied, copy the fixture to `/tmp` and rewrite the parent and child Moltnet server ports separately; the source fixture uses `8787` in both the root team and nested field team, so a blind replacement can make both servers bind the same port.
- A known-good isolated live command is:

  ```bash
  tmp="$(mktemp -d /tmp/spawnfile-team-chat.XXXXXX)"
  cp -R examples/moltnet-team-chat/. "$tmp"
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
- **Interim live-model regression check (Slice B), do not delete:** `moltnetTeamChat.ts` (plus `moltnetTeamChatBusyTurn.ts` and `moltnetTeamChatB20.ts`, which share its plumbing) proves a busy-turn burst gets one real reply carrying every queued marker — genuinely unfakeable live-model behavior, not something a fake-engine unit test can stand in for. This is kept as-is pending the compose-and-observe pipeline (Spawnfile org + Simfile world, composed and observed read-only from `simfile`, per the project direction to delete bespoke orchestration harnesses once the platform gap they work around is fixed rather than reimplement them there). Do not touch its shared plumbing while it's still the only thing exercising this path.
- Memory wiring E2Es are compile/report checks, not mocked model conversations. They compile the mixed-runtime and Jungian fixtures, assert Moltnet topology, assert memory capability reporting, and inspect generated memory transport outcomes. The generated-app E2Es above are the ones that execute runtime turns. Known-good commands are:

  ```bash
  npm run test:e2e:mixed-runtime-memory -- --fixture examples/mixed-runtime-org
  npm run test:e2e:jungian-self-org -- --fixture examples/jungian-daimon-org
  ```

- The Ollama embeddings probe is optional. It checks the configured endpoint and returns skipped when Ollama or the requested embedding model is unavailable:

  ```bash
  npm run test:e2e:ollama-embeddings-probe -- --base-url http://127.0.0.1:11434
  ```

- The E2E preflight reports local readiness for Codex, Claude, Grok, Antigravity, Ollama embeddings, Docker local/remote contexts, Moltnet CLI availability, and compile-only mixed-runtime wiring for Mneme, Daimon, OpenClaw, and PicoClaw. It does not run live model conversations:

  ```bash
  npm run test:e2e:preflight
  npm run test:e2e:preflight -- --json
  ```

- After any interrupted live run, clean up the isolated container/image and confirm the developer's active containers are still present: `docker rm -f spawnfile-team-chat-retry || true`, `docker image rm -f spawnfile-team-chat-retry || true`, then `docker ps --format '{{.Names}} {{.Ports}}'`.

- **Lifecycle smoke (Slice B, Piece 5 step 5) — `lifecycleSmoke.ts`,
  `npm run test:e2e:lifecycle-smoke`:** proves the documented
  `spawnfile up`/`artifacts export`/`down --json` receipt contract end to end
  against a minimal single-agent SCRIPTED fixture
  (`fixtures/lifecycle-smoke`, no model auth). It asserts up-receipt
  fields (`fingerprint`, `run_id`, non-empty `compiled_schedule`,
  `readiness.moltnet_base_url`, `engines`), that Moltnet's `/healthz`
  answers, that `artifacts export --json`'s export-index lists a genuinely
  non-empty file under `raw/moltnet/`, `raw/mneme/`, and `raw/daimon/` (each
  checked against the actual file on disk, not just the index's self-reported
  size), and a clean `down --json` receipt (`errors: []`). It seeds exactly
  ONE `@watcher` mention as plumbing — the only way to guarantee the exported
  artifacts are genuinely non-empty — but that is a precondition, never a
  reported assertion: this harness makes **zero transcript/turn/behavior
  assertions** (Decision 20 — that lives in `ecosystem/simfile` now). It is
  the coverage safety net that keeps this folder's e2e suite off zero now
  that the office-sim monolith (see "Retired" above) is deleted; run it live
  once after `npm run build` + `npm run build:local-moltnet`:

  ```bash
  npm run test:e2e:lifecycle-smoke -- --timeout-ms 180000 --poll-interval-ms 2000
  ```

  A passing run prints `Lifecycle smoke E2E passed (...)`. Uses an isolated
  Moltnet port (`19961`) never a developer's active port.
