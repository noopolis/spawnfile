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
├── daimonOrg.ts    # Generated Daimon app smoke with real Codex auth — interim live-model regression check (Slice B note below), kept even though it also re-proves some already-unit-tested compiler wiring/memory persistence
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
├── runtimeRootfsPaths.ts # Shared local-rootfs path/memory-path-rewrite helpers for generated-app E2Es
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
- The Daimon org E2E compiles `examples/daimon-org`, injects real Codex OAuth into the generated Pi home, installs the generated Daimon runtime package, runs the generated app twice, and asserts that two Daimon agents wrote through a shared workspace resource and recorded/recalled Mneme memory. **Interim live-model regression check (Slice B), do not delete:** two real Codex agents actually writing to a shared workspace path is unfakeable live-model behavior, kept as-is pending the same compose-and-observe pipeline noted above (its compiler-wiring/memory-persistence assertions overlap with unit coverage elsewhere, but splitting those out was judged not worth the churn while this file is still flagged interim). Pi currently requires Node 22.19+; a known-good command is:

  ```bash
  PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" \
    npm run test:e2e:daimon-org -- --keep-artifacts
  ```

- **Slice A redundancy removal (test-ownership Decision 20):** the former
  `daimonCliMemory.ts`/`daimonCliMemoryTraces.ts` (generated Daimon CLI-engine
  memory/dream smoke, `npm run test:e2e:daimon-cli-memory`), `memoryAblation.ts`/
  `memoryAblationEngines.ts`/`memoryAblationSeed.ts` (B70 on/off/shuffled
  recall-mode ablation, `npm run test:e2e:daimon-memory-ablation`), and
  `allRuntimeMemoryDream.ts`/`allRuntimeMemoryDreamCli.ts` (a thin wrapper
  running the CLI-memory E2E plus `memoryIntegration.ts`'s mixed-runtime wiring
  check together, `npm run test:e2e:all-runtime-memory-dream`) were deleted:
  every mechanic they proved is now covered by an in-process test, with no
  coverage lost.
  - Turn causal stamping (`turn.input.submitted`/`turn.output.completed`
    around the CLI engine call) → `src/runtime/pi/appCliSource.test.ts`
    ("CliEngineAgentHandle turn causal stamping").
  - Generated turn-trace shape/secret-redaction → `src/runtime/pi/appActivitySource.test.ts`.
  - The turn-trace↔activity-event JOIN (`agent.turn.started`/`.completed`
    sharing `wake_id`/`wake_kind`/`trace_path` with the trace file) →
    `src/runtime/pi/appCoreSource.test.ts` (new; this generated file had no
    test before).
  - Recalled-memory-text-lands-in-the-generated-prompt, and `MNEME_RECALL_MODE`
    on/off/shuffled gating what lands there → `src/runtime/pi/appCliSource.test.ts`
    ("CliEngineAgentHandle wired to the real @noopolis/mneme memory runtime";
    new — wires the real `@noopolis/mneme` `createMemoryRuntime` through the
    generated `CliEngineAgentHandle`, the one B70 assertion mneme's own tests
    below can't reach because they don't know `createCliEnginePrompt` exists).
  - B70 recall-mode selection/audit correctness itself (candidate ranking,
    token-budget selection, shuffled decoy substitution, kernel search/locate
    gating) → `@noopolis/mneme`'s own `runtime.test.ts`/`recallMode.test.ts`
    (`ecosystem/mneme`), unaffected by this deletion.
  - `readMemoryAblationEvidence`/`memoryAblationEvidence.ts` had no consumer
    anywhere else in this repo (only `memoryAblation.ts` and its own test
    imported it), so it was deleted alongside rather than kept as a dangling
    reader. The `slice-memory-ablation` acceptance check
    (`src/e2e/acceptance/profiles.ts`) stays declared — it is repointed, with
    an inline comment, at the unit tests above instead of the deleted E2E run.
  - `daimonCliMemoryTraces.ts`'s `getGeneratedInstanceRoot`/
    `GeneratedMemoryEvent`, its only pieces still genuinely used elsewhere at
    the time (by the since-deleted `autonomousOfficeSim.ts`), moved to
    `autonomousOfficeSimHarnessSupport.ts` before this file was deleted; that
    module (and everything importing it) was itself deleted whole in the
    Piece 5 office-sim-monolith retirement above, with no further consumer.

- Memory wiring E2Es are compile/report checks, not mocked model conversations. They compile the mixed-runtime and Jungian fixtures, assert Moltnet topology, assert memory capability reporting, and inspect generated memory transport outcomes. The generated-app E2Es above are the ones that execute runtime turns. Known-good commands are:

  ```bash
  npm run test:e2e:daimon-memory-recall -- --fixture examples/mixed-runtime-org
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

- The moltnet-memetics E2E (`runMoltnetMemeticsE2E`, `moltnetMemetics.ts`) drives
  one real Eleanor<->Sam conversation through a real Docker container running a
  compiled `fixtures/moltnet-memetics` fixture: two `runtime: pi`
  (`engine: codex`) agents, one managed Moltnet network/room (`memetics_lab`/
  `eleanor-home`), both with `wake: mentions` — an agent only wakes when a
  room message @mentions their id, so turn-taking is explicit rather than
  both agents waking in parallel off every message. The fixture's `pi` runtime install
  recipe pins the published `@noopolis/daimon@0.1.2` and
  `@noopolis/mneme@0.1.1` releases. Local package overrides remain an explicit
  development option and are never inferred from checkout layout. Both agents
  use the same real-Codex
  model shape as `daimon-org`'s agents (`provider: openai`, `auth.method:
  codex`, no `endpoint`) so `preparePiRuntimeAuth`
  (`src/runtime/pi/runAuth.ts`) mounts real Codex OAuth into
  `.pi/agent/auth.json` at container start — unlike `daimonOrg.ts`, this
  harness never writes rootfs auth files directly; it goes through the same
  `syncProjectAuth` + `createDockerRunInvocation` path as `moltnet-team-chat`.
  It reuses `moltnetE2ESupport.ts`'s exported `createMoltnetHttpClient`, `poll`,
  `waitForRoom`, `waitForAgents`, `waitForRuntimeReadiness`,
  `runDockerCommand`, `resolveAuthProfile`, `cleanup`, and `formatHistory`
  (also re-exported from `moltnetTeamChat.ts` for back-compat) rather than
  reimplementing Docker/Moltnet orchestration. The Pi/Daimon
  runtime's control server answers `/healthz` (not OpenClaw's `/api/agents`
  fallback), which is why `healthPathForRuntime` now maps both `pi` and
  `daimon` to `/healthz`. The harness seeds one operator message into
  `eleanor-home` mentioning only `@eleanor` and carrying a high-entropy
  sentinel token (default `ORCHID-417`, override with `--seed-token`) as a
  real negotiation to finalize with Sam (propose two specifics, get his
  agreement) rather than a bare confirmation, then drives/observes the room
  through `moltnetMemeticsExchange.ts`'s `waitForConversationExchange`
  until the full multi-turn exchange is complete — not just Eleanor's first
  reply and Sam's first reply — because each agent's own persona/`AGENTS.md`
  instructs it to @mention the teammate it wants to respond (what wakes the
  next agent under `wake: mentions`, with the bridge auto-publishing each
  reply back into the room — no relay is built here) and Eleanor's persona
  explicitly closes the negotiation in a 3rd turn after Sam's pushback.
  Completion is the first of: the target agent-turn count is reached
  (`--target-turns`, default 4, clamped to a minimum of 3 so the close can
  never be truncated), a quiet period elapses with no new agent message
  after the last one (`--quiet-grace-ms`, default 35s — longer than one
  grok turn, ~20-25s — so a wake already in flight is never torn down
  mid-generation), or the overall `--timeout-ms` is hit. The pure
  turn-cap/quiet-timeout/timeout decision (`evaluateExchangeCompletion`)
  is isolated from the polling loop so it is unit-tested without fake
  timers. Only after the exchange concludes does the harness — before
  container cleanup — write a kept run folder
  (`--out`, else a fresh `mkdtemp`, never auto-removed) containing
  `transcript.jsonl`, `transcript.md`, and a best-effort `docker cp` of each
  agent's `runtime/agents/<slug>/` directory (per-agent
  `telemetry/causal.jsonl` causal events plus the real Codex CLI's redirected
  `codex-home/.codex` tree and `codex-<timestamp>.txt` last-message capture)
  from `<instance-root>/runtime/agents` (`instance-root` = the parent of the
  compiled instance's `home_path`). A passing run prints `Moltnet memetics
  E2E passed (...)`. Same isolated-port discipline as `moltnet-team-chat`:
  copy the fixture to a temp directory and rewrite its Moltnet port before
  running on a developer machine, e.g.:

  ```bash
  tmp="$(mktemp -d /tmp/spawnfile-memetics.XXXXXX)"
  cp -R fixtures/moltnet-memetics/. "$tmp"
  perl -pi -e 's/8787/21092/g' "$tmp/Spawnfile"
  npm run test:e2e:moltnet-memetics -- \
    --fixture "$tmp" \
    --base-url http://127.0.0.1:21092 \
    --container-name spawnfile-memetics-retry \
    --image-tag spawnfile-memetics-retry \
    --out /tmp/moltnet-memetics-run \
    --keep-artifacts \
    --timeout-ms 300000 \
    --poll-interval-ms 3000 \
    --target-turns 4 \
    --quiet-grace-ms 35000
  ```

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

- `fixtures/support/scripted-engine/office-engine.mjs` (Slice B, Piece 5
  step 1) is a standalone script speaking the pi runtime's `scripted` engine
  argv contract (`--prompt-file <path> --cwd <workspacePath>`, reply text on
  stdout) — see `src/runtime/pi/AGENTS.md`'s `appCliEnginesSource.ts`/
  `appScriptedEngine.ts` notes for the platform side. The office-sim scenario
  that originally motivated it has since moved to
  `ecosystem/simfile/fixtures/sims/office-sim` (its own copy of this script);
  this copy stays because two unrelated unit tests
  (`src/runtime/pi/adapter.test.ts`, `src/compiler/containerArtifacts.test.ts`)
  reference `fixtures/support/scripted-engine` directly as a generic
  fixture proving the pi adapter's `scripted` engine kind.
  `src/e2e/officeEngineScript.test.ts` spawns the standalone script as a child
  process and asserts its stdout against inlined constants (the screenplay
  text has no TypeScript source of truth left to import from since
  `officeSimEngines.ts` was deleted), so the two copies cannot silently drift
  apart undetected.
