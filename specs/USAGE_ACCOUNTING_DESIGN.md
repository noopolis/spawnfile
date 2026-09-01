# Usage accounting — Daimon measures, Spawnfile aggregates

*Revision 3. Two independent reviewers (fable, agy) rejected revision 2 on the
same two defects, found by tracing container machinery the design never named.
Findings folded in at the end.*

## Why

On 2026-08-28 a Grok subscription was exhausted without publishing anything.
Reconstructing the spend afterwards was impossible: both engines report token
usage every turn and Daimon discards it at `cliSession.ts:324`, where a `Usage`
struct is emitted hardcoded to zeros. Turn counts survived in the broker
receipts; token counts existed nowhere.

Measured on the live container:

    codex exec --json             "say OK" → input 12,346 · cached 5,504 · output 5
    grok --output-format json     "say OK" → input  8,746 · cached 5,760 · output 29
                                             costUSD 0.0035

~10k tokens of fixed context per turn before any work, and 2,481 wakes in 24h.
Nothing in the system could say so at the time.

## Boundary

Usage is a **runtime** fact, not a product one.

    daimon      measures one turn        agent · wake · engine · tokens
    spawnfile   aggregates the org       by agent, by engine, over a window
    clank       correlates if it wants   maps its own event_keys to wake ids

No Daimon or Spawnfile artifact names an edition or any other Clank concept.
`specs/ECOSYSTEM_RUNTIME_BOUNDARIES.md:153` already assigns per-agent turn
telemetry to the agent runtime, so Spawnfile aggregating it through a versioned
artifact is the intended contract shape, not a boundary breach.

## Route

Production Grok does **not** take the direct-spawn path. Verified:

    organizationRuntimeReadiness.ts:29-33   any grok agent → broker, unconditionally
    engineDispatcher.ts:93                  wires grokBrokerTurn
    cliSession.ts:258-260                   broker branch returns before line 289
    grokEngineBroker.ts:24                  ← decodeGrokHeadlessResult runs HERE

Extraction goes in the decoder (shared by both callers). Persistence goes in the
broker, in the **success branch only** — `finish()` also runs in the catch path,
and a completed replay returns at `grokEngineBroker.ts:21` before the try block,
so a call placed after the success `finish()` structurally cannot double-count.

### Ruled out, with reasons

- **Inside the `completed` frame.** The durable record is re-validated by the
  strict wire parser (`engineBrokerTurnRegistry.ts:22` → `parseEngineBrokerResponse`,
  exact field set at `engineBrokerProtocol.ts:55`). An extra field makes the next
  `begin()` throw permanently — crash-recovery replay breaks. Proven by probe test.
- **Returned from `turn()`.** `engineBrokerService.ts:20` spreads the result onto
  the wire; the strict client would reject every completed turn.
- **An unprovisioned path.** Revision 1 chose `/var/lib/spawnfile/daimon/usage/`
  without creating it. The writer is pinned to uid 2100
  (`engineBrokerServiceCli.ts:10`); only the realm dir is provisioned
  (`containerDaimonBrokerRender.ts:83`); the parent is a root-owned mountpoint.
  `mkdir` returns EACCES, and because writes are advisory the ledger would be
  **silently empty forever**.

## Artifact

A dedicated persistent volume, provisioned like the realm, owned by the broker.

    /var/lib/spawnfile/daimon/usage/           0750, chown 2100:2100, root-provisioned
      usage.jsonl                              0640, append-only

Three changes make it real, all previously missing:

1. `containerDaimonBrokerRender.ts` — a `mkdirSync` + `chownSync(2100,2100)` +
   `chmodSync(0o750)` line beside the existing realm line.
2. `spawnfile/src/runtime/daimon/config.ts` — a `persistentMounts` entry, so the
   ledger survives redeploy. Without it the file lives in the container writable
   layer and dies exactly when the incident report is needed.
3. `containerDaimonBrokerRender.ts:92` — a worker deny-list entry. Peer isolation
   is an explicit posture there; a readable ledger would leak every agent's wake
   ids and cadence to every sandboxed worker.
4. **`containerDaimonUidEntrypointRender.ts:103-111` — exclude the usage mount
   from `state_roots`.** This is the one revision 2 missed and it is fatal without
   it. The ownership guard runs *before* broker provisioning (guard at `:270-281`,
   provisioning spliced at `:286`) and recursively chowns every persistent mount
   to uid **2000** on every container start (`containerDaimonOwnershipGuardRender.ts:115-126`).
   The realm survives only because of a hardcoded exact-path exclusion at `:111`.
   Without a matching exclusion: boot 1 works, and from boot 2 onward the guard
   chowns `usage.jsonl` to 2000, the broker's `O_APPEND` gets EACCES, the advisory
   posture swallows it, and the ledger is **silently empty forever** — the same
   hole as revision 1, one boot later. Add a boot-time write probe beside the
   existing realm probes (`:300-306`) so the failure is loud rather than silent.

**The record carries no `org`.** Revision 1 put one in, which would have forced a
5th key into a config parser that asserts exactly 4
(`engineBrokerServiceCli.ts:20`) plus both contract manifests. Unnecessary: one
ledger per container, one organization per container, so identity comes from
*which container was queried*.

```json
{"v":"noopolis.daimon.turn-usage.v1",
 "agent":"cogsworth","wake":"…","engine":"grok","at":"2026-08-29T01:12:04Z",
 "input":8746,"output":29,"cache_read":5760,"cache_write":0,
 "total":20535,"calls":1,"notional_usd":0.0035,"complete":true}
```

- **Numeric-only, plus `agent` and `wake`.** No engine-controlled string is ever
  persisted — which is why `perModel` is **dropped**: its keys are model names
  chosen by the engine. Grok reports `costUSD` itself, so no rate table is lost.
- **`wake` is caller-supplied, not Daimon-owned.** It is `event.id` from the wake
  request (`piAgentHandle.ts:157`), schema-bounded to 4096 codepoints
  (`organizationRuntimeContract.ts:7`), fixed before the engine runs — so it is
  engine-free, but it is external text. **Truncate to 128 characters** in the
  ledger. JSON escaping already prevents line injection.
- **`total` includes cache**, matching the pi-ai `Usage` convention. Cached
  context is the dominant cost; excluding it hides the thing being measured.
- **`complete:false` is a heuristic, and its blind spot is stated.** Production
  hardcodes `streaming-messages-json` (`engineBrokerLauncherCore.inc:326`). No
  fixture in either repo records what that format's `result` frame actually
  carries, and a zero-filled usage block is **byte-indistinguishable** from a real
  one — "the engine zero-filled" is not a wire-observable event. The rule is
  therefore: `complete:false` when the usage block is absent, or when
  `input == 0` (no real turn has zero input tokens). **This cannot catch the
  partial case** — a multi-model turn where one entry is zero-filled sums to a
  plausible nonzero total and is stamped `complete:true` while undercounting.
  Capture a real `result` frame as a fixture before implementing, and if the
  format proves to carry no completeness signal at all, label every count a lower
  bound rather than claiming detection.
- **`notional_usd`, never `cost`.** Flat subscriptions; nothing is billed.
- **Advisory.** A malformed usage block, or a failed append, writes no line and
  never fails a turn that published.

### Append discipline

One writer process per container (the single broker service), so plain `O_APPEND`
is correct and temp-write-rename would be wrong for an append-only file. Two
rules make it safe, both testable:

- **One `write(2)` per complete line**, since turns for different agents run
  concurrently inside the broker (`grokEngineBroker.ts:16`).
- **The reader skips any unparseable line and any unterminated trailing line** —
  a crash mid-append leaves a torn final record.
- **The append is wrapped in its own try/catch.** The insertion point sits inside
  the try block whose catch calls `finish(..., failed)` unconditionally
  (`grokEngineBroker.ts:25`), and `finish` has no terminal-state guard — it
  renames over an existing record (`engineBrokerTurnRegistry.ts:26-31`). An
  escaping append error would rewrite an already-*completed* turn as *failed*.
  This is the one place where getting "advisory" wrong corrupts turn state instead
  of dropping a line, so it gets its own mutation test.

Rotate at 64 MB to a `.1` sibling, keeping one generation. ~2.5k lines/day
observed, so that is months.

## Transport — how Spawnfile reads it

The ledger is inside the container. `spawnfile usage` runs on the host, which on
this dev machine is macOS Docker Desktop, and may target a remote Docker context.
A host-side `readFile` is impossible in both cases.

Reads go through the **existing sanctioned channel**: the docker probe gateway
(`spawnfile/src/deployment/dockerProbeGateway.ts:122-135`), which already supports
`--context` / `--host` remote targets via `withDockerTarget` (lines 39-50) and is
already used to `cat` container files (`dockerManager.ts:324-333`). `docker exec`
runs as the image user — root for a Daimon image
(`containerArtifactsRender.ts:296`) — so a 0640 uid-2100 file is readable.

    spawnfile usage → dockerProbeGateway → docker exec → cat usage.jsonl → parse → group

Three constraints the channel imposes, all missed by revision 2:

- **The gateway cannot return more than 1 MiB.** It calls `execFile` with only
  `{ timeout }` (`dockerProbeGateway.ts:14`, `:125-132`), and its injectable type
  admits no other option, so Node's 1 MiB `maxBuffer` default applies. At ~575 KB
  of ledger per day the `cat` starts failing on **day two**. The gateway's
  contract must gain a `maxBuffer`, or the reader must stream/tail. This is a
  change to the channel, not merely a new caller of it.
- **A stopped container has no `docker exec`.** The scenario that motivated this
  feature is a post-mortem, and `spawnfile down` deliberately preserves volumes.
  So the reader falls back to the repo's own volume-egress pattern — `docker
  create` from the deployment image plus `docker cp`, as `artifactsExportDocker.ts`
  already does — whenever exec is unavailable.
- **A fresh ledger does not exist.** `cat` returns ENOENT and a non-zero exit
  before the first turn ever completes; `spawnfile usage` must render that as an
  empty ledger, never as an error.

Rotation means the reader must read **both generations** (`usage.jsonl` and
`usage.jsonl.1`), or a `--since` window spanning a rotation silently loses lines.

## Surface

A new command. `status` answers *is it healthy*; usage answers *what did it
consume* — different question, different cadence, and `status` must not read a
growing ledger on every invocation.

    spawnfile usage                      org total, last 24h
    spawnfile usage --since 7d           window
    spawnfile usage --by agent           default
    spawnfile usage --by engine          rollup
    spawnfile usage --agent cogsworth    one agent
    spawnfile usage --top 5              the runaway, immediately
    spawnfile usage --json               machine-readable

```
ORG daimon-organization · last 24h · coverage PARTIAL (10 of 16 agents)

agent          engine   turns   tokens   notional   share
cogsworth      grok       121     2.1M     $6.80     34%
foreman        grok        78     1.4M     $4.30     22%
brass          codex        —        —         —        —
──────────────────────────────────────────────────────────
grok                      451     5.9M    $18.85
codex                       —        —         —
```

**`status` gets no usage line.** Revision 1 added a pointer showing live 24h
aggregates, which would have required exactly the read it forbade.

**Coverage is always explicit.** With Codex uninstrumented, six of sixteen agents
report nothing, so a total is labelled `PARTIAL` and never presented as the org's
cost.

## Scope

**In:** Grok — ten of sixteen agents, and the account that actually died.

**Out — Codex.** `--json` changes how every Codex reply is extracted
(`readChild`'s last-64KB-of-stdout → the `item.completed` agent_message) inside
`cliSession.ts`, a file named in the outstanding A2 P1 findings. Belongs with A3.

**Out — quota percentages.** Neither CLI exposes the denominator: codex `--json`
has no rate-limit event, `logs_2.sqlite` has no rate-limit columns, grok's only
usage-adjacent command is `du`.

## Files

    daimon/src/pi/grokHeadlessResult.ts              extract usage; supersede the dead draft
    daimon/src/runtime/turnUsageLedger.ts            new — append one line, advisory
    daimon/src/runtime/grokEngineBroker.ts           call it in the success branch
    daimon/src/contracts/runtimeContractManifest.ts  register turn-usage.v1
    spawnfile/src/compiler/containerDaimonBrokerRender.ts  provision dir + deny-list entry
    spawnfile/src/compiler/containerDaimonUidEntrypointRender.ts  exclude usage from state_roots + write probe
    spawnfile/src/deployment/dockerProbeGateway.ts   maxBuffer (or a streaming read)
    spawnfile/src/runtime/daimon/config.ts           persistent mount
    spawnfile/src/runtime/daimon/contractManifest.ts mirror turn-usage.v1
    spawnfile/src/runtime/usageLedger.ts             new — read via probe gateway, window, group
    spawnfile/src/cli/usageCommand.ts                new — the command

## Verification

1. **Decoder** — summed usage; malformed/renamed/stringified field → `undefined`
   and no throw; an `error` stream carrying plausible usage still throws; a canary
   in the engine's usage block appears nowhere.
2. **Ledger** — one line per completed turn; a **replayed** turn writes no second
   line; a failed append does not fail the turn; a torn trailing line is skipped
   by the reader and the rest still parses.
3. **Provisioning** — the render emits the mkdir/chown/chmod and the deny-list
   entry; the mount appears in `persistentMounts`; the usage path is **absent**
   from the entrypoint's `state_roots`; a second simulated boot leaves the ledger
   owned by 2100 and writable.
4. **Transport** — a ledger larger than 1 MiB is read successfully; a stopped
   container falls back to volume egress; a missing ledger renders as empty;
   a window spanning a rotation includes the rotated generation.
5. **Aggregation** — grouping by agent and by engine; window filtering; `PARTIAL`
   coverage when an engine reports nothing.
6. **Mutation** — delete the cache terms from `total`; delete the
   malformed-rejection guard; delete the replay suppression; delete the
   torn-line skip; delete the append's try/catch and assert a completed turn is
   not rewritten as failed. Each must turn a test red.
7. **Regression** — targeted `src/pi` and `src/runtime`, then the full suite.

## Findings folded in (revision 2 → 3)

Found independently by two reviewers, by tracing container machinery:

- **P0 ownership guard** — the guard chowns every persistent mount to 2000 on
  every boot, before provisioning. The ledger would be silently unwritable from
  the second boot onward. Fixed by a `state_roots` exclusion plus a write probe.
- **P1 1 MiB gateway ceiling** — `execFile` with no `maxBuffer`; reads break on
  day two. The channel itself must change.
- **P2 stopped containers** — the post-mortem case has no `docker exec`; volume
  egress added as fallback.
- **P2 `complete:false` unobservable** — downgraded to a stated heuristic with its
  blind spot written down, and a fixture required before implementing.
- **P2 fresh ledger ENOENT** — rendered as empty, not an error.
- **P3 append error could clobber a terminal record** — own try/catch, own mutation.
- **P3 rotation dropped from queries** — read both generations.

## Findings folded in (revision 1 → 2)

- **P0 unwritable/unreachable ledger** — now provisioned, mounted, deny-listed,
  and read through the probe gateway.
- **P2 broker cannot name the org** — `org` removed from the record entirely;
  identity comes from the queried container.
- **P2 append discipline unspecified** — single-write rule, torn-line skip, and a
  mutation for each.
- **P2 world-readable ledger leaked peer activity** — 0750/0640 plus a worker
  deny-list entry.
- **P3 `wake` overstated as Daimon-owned** — corrected; truncated to 128 chars.
- **P3 `status` contradiction** — pointer line removed.
- **P3 no retention, no manifest entry** — 64 MB rotation, one generation;
  schema registered in both contract manifests.
