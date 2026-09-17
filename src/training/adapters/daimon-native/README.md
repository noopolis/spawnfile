# Native Daimon attention trials

`createDaimonNativeAdapter()` runs one selected Codex attention agent through
Daimon's public organization control host in a fresh local Linux container. This
is separate from the existing Pi/session adapter. Paideia does not compile the
organization, rebuild the identity envelope, substitute fixture tools or implement
Mneme. Caller preparation supplies canonical native config and immutable code.

## Public entry points

- `@noopolis/paideia/adapters/daimon-native`: adapter, launch schema and types.
- `@noopolis/paideia/adapters/daimon-native/worker`: `runDaimonNativeWorker(args)`.
  Importing this subpath never starts a worker. The separate built `worker/cli.js`
  file is the container CLI entrypoint when no project bootstrap is declared.

Preparation writes `native-launch.json` in the trial runtime home. The strict
`paideia.daimon-native.launch.v1` schema requires:

- Exact compiled-config and source-config SHA-256, immutable container image,
  selected agent ID, Codex model and loopback host endpoint.
- The candidate instruction file's relative path and raw byte digest, plus a
  `trim-surround` rendering receipt. The worker checks the complete native
  instructions equal `prefix + rawCandidate.trim() + suffix` and verifies their
  separate digest. Compiler normalization never changes the candidate byte identity.
- Fresh workspace/home projections, any declared memory/transport/state
  projections, and at most one explicit read-only Codex credential ingress file.
- Applied single-agent selection and disabled-schedule override receipts, with
  original values and reasons. The caller owns compiler provenance; the adapter
  checks the selected effective config without pretending to recompile it.
- Explicit token limits, protected control/config/token paths, environment file,
  built worker directory and optional trusted project bootstrap.

The container needs Node at `/usr/local/bin/node`, the public Daimon runtime,
Paideia's dependencies, and the caller's canonical native engine/backend programs.
The adapter mounts the built native adapter directory at `/opt/paideia/native`.
An optional bootstrap mounts at `/opt/paideia/bootstrap` and receives the worker
arguments. That trusted caller code owns local transport startup; it must call
the public worker afterward. Controls and bearer token stay under `/run/paideia`.
The optional Daimon dependency is loaded only by the native worker.

## Evidence and cancellation

The authenticated HTTP endpoint forwards actual native activity for production
backends. One v2 acceptance must reach idle execution plus matching closed native
telemetry, usage and observed Codex model identity. An inbox completion receipt
alone cannot complete a trial. Native metering retains cached-input tokens. Per-wake records stay available and
the logical task returns their aggregate once; any unknown wake makes the total
unknown. Tool receipts can be cumulative and are deduplicated as observations.

Real MCP/Moltnet receipts yield partial tool observations; unobserved arguments
and built-in tools remain absent. Native attention final prose is absent. Projects
can evaluate authentic filed artifacts through their own collectors. Missing
usage remains unknown. The terminal evidence retains preparation receipts.

A completed execution that defers its inbox delivery stays a failed trial with
`blocked: "awaiting-external-input"` in terminal evidence. Recorded usage and
receipts remain available. An optional `externalInputs` callback can supply at most
three genuinely sourced deliveries, only after this deferred state. Each delivery
requires a stable identity and exact content hash, becomes an `input` observation,
and gets its own public native acceptance. The original deadline covers all wakes;
usage is aggregated once. Missing or unmatched responses leave the trial blocked and stop its owned runtime.
The callback owns isolated transport and must honor cancellation; the adapter never
fabricates a response or connects an organization on its own.

Cancellation requests native stop, then stops/kills the owned labeled container
and independently verifies removal. Unknown containment never becomes confirmed.
Evaluator files are excluded from projections, and native Codex protection denies
runtime controls and engine credentials. Prepared memory must be fresh local state;
this adapter does not create or copy historical memory.

Only one logical Codex task with the workspace-no-network policy, or one brokered
Grok task in child-process execution (below), is supported. Other engines, plain Pi equivalence, unrestricted multi-turn conversations, complete built-in
tool traces and final-output capture are unsupported. Unit host/command doubles
test wiring and rejection paths; they are not authenticated native acceptance.


## Child execution inside a shared training container

`createDaimonNativeAdapter({ execution: { kind: 'child-process' } })` starts one
fresh worker child per trial inside the caller-owned Linux training container.
It uses the same public worker, authenticated loopback protocol, observations,
usage and sourced continuation loop. It does not create a container or require a
Docker socket. The default adapter still owns a separate Docker container.

The actual workspace and home/memory paths must match their source/target launch
receipts. Subject data belongs outside `/run` and `/tmp` (for example under
`/work/subjects/<trial>`); evaluator inputs, captures, controls and checkpoints
stay under the native sandbox's denied `/run` root. The launcher runs as a
non-root user and supplies the existing native sandbox compatibility settings.
Before any wake the adapter executes the exact Daimon-generated sandbox policy:
workspace read/write must work, every declared protected path must deny opening,
and a live local listener must be unreachable. Only a final on-disk completion
marker establishes success. This preserves native path protection, without
claiming a fresh per-agent container or general process separation.

The optional `execution.prepare({ launch, trialId, signal })` callback delegates
credential ingress staging to the caller's public owner API. Paideia validates
staged leaf modes and paths; it never imports subscription credentials. Worker
arguments are exposed by `nativeChildArguments`; each uses the actual private
launch/config/control/token paths. The child's environment contains the declared
env-file plus basic process locale/PATH, without ambient provider settings.

Child research callbacks live at `execution.externalInputs` and receive
`executionId`, never a Docker `containerName`. Legacy Docker `externalInputs`
cannot be combined with child execution. Stopping cancels pending HTTP and
research callbacks and prevents a subsequent wake.

Normal closure requires matching completed native execution evidence, idle native
activity, acknowledged native stop and an observed clean worker exit. Cancellation,
crash or forced termination without that evidence remains `quiescence: unknown`;
the experiment must fail and the caller stops the whole shared container. No safe
continuation after uncertain cancellation or remote-model cancellation is claimed.

Real loopback child fixtures verify lifecycle and capture wiring. A separate
zero-model native-image probe verified the actual protected-path policy; neither
is an authenticated model optimization run.


## Brokered Grok trials (`paideia.daimon-native.launch.v2`)

Status: implemented and unit-tested against Daimon's public contract; not yet
exercised in a live broker-capable training container (the slot supervisor that
writes the preflight receipt is Spawnfile P5).

`launch.v2` adds an engine choice. `agent.engine: "codex"` behaves exactly like
v1 (at most one read-only ingress credential); v1 receipts still parse as Codex,
so restored runs and measurement repairs keep working. `agent.engine: "grok"`
records the declared `model` (`grok-4.6`, `grok-4.5`, `grok-build`) and
`reasoningEffort` (`low`, `medium`, `high`), carries `credentials: []` and a
`broker` section:

| Member | Meaning |
|---|---|
| `projectionVersion`, `projectionSha256` | `noopolis.daimon.grok-broker-projection.v1` and the canonical digest the slot supervisor bound |
| `slot`, `workerUid`, `workerHomePath`, `architecture`, `usageLedgerPath`, `seccompProfileSha256`, `limits` | Passed verbatim to Daimon's `resolveOrganizationGrokBrokerProjection` |
| `evaluatorPaths[]` | `{role, path}` for `run-root`, `context`, `sealed-inputs`, `judge-home`, `slot-ledger` (the usage ledger directory); passed as the projection's `denyPaths` |
| `slotPreflightReceipt` | Input path contract: the root slot supervisor writes `noopolis.daimon.grok-slot-preflight.v2` here after provisioning or recycling the slot |
| `expectedNonce`, `minGeneration` | This trial's recycle freshness: the nonce Paideia sent with the recycle request and one above the last generation it accepted for the slot |

Startup, in order, with no model call and no `codex sandbox` process:

1. The worker loads Daimon's Grok exports (`resolveOrganizationGrokBrokerProjection`,
   `grokBrokerProjectionSha256`, `verifyGrokSlotPreflightReceipt`) and fails closed
   if any is missing. The config must declare the same model and effort and no
   Codex sandbox; broker token limit must not exceed the launch wake ceiling.
2. The resolved projection's canonical digest must equal Daimon's digest and the
   launch receipt; its turn timeout must fit the trial deadline.
3. The slot receipt must exist and pass Daimon's verifier (exact deny-path canaries,
   profile, seccomp, executable, and freshness: the launch nonce and a generation
   of at least `minGeneration`; v1 receipts are refused). Paideia then requires the control root and every
   evaluator root to be an exact denied canary and the config/token/env files to
   sit inside a denied root, and persists `sandbox-projection.json`.
4. The ready line adds `engine` and `reasoningEffort`; the parent requires them to
   match the launch. The parent re-binds the persisted receipt without Daimon and
   additionally requires every caller `protectedPaths` entry as a denied canary.
   Child execution must supply `grokSlots`, a `createGrokSlotFreshnessStore(file)`
   kept in the experiment state: preparation calls `request(slot)` to mint the nonce
   and generation floor it writes into the launch and sends with the recycle request;
   the parent's `accept` requires the pending nonce and a strictly higher generation
   and persists it, so a receipt can never be replayed into a later trial.
   Every store operation re-reads the file under an O_EXCL lockfile shared across
   store instances and processes (a lock whose owner PID is gone is reclaimed), never
   lowers a generation floor on disk, and refuses a symlinked or hard-linked state file.

Separate-container Grok is refused before any Docker call. The worker sets the
engine-neutral `DAIMON_ENGINE_WAKE_TIMEOUT_MS`/`_TOKEN_CEILING` (Codex aliases equal)
and points `DAIMON_TURN_USAGE_LEDGER_PATH`/`DAIMON_TURN_REQUESTS_LEDGER_PATH` at the
slot ledger, which the broker writes and which must be empty at trial start.

Evidence reads Grok usage rows with `total = input + cache_read + cache_write +
output`, the declared model or its `-build` alias and a `turn` key; byte-identical
rows per `turn` count once and conflicting ones fail. Per-request rows keep
`usage_source`, `started_at` and `ended_at` in `native.requests`; `estimated_requests`
stays on the usage row and makes usage coverage partial. Normalized usage has
`inputTokens = input + cache_read + cache_write`, `cachedInputTokens = cache_read`,
`cacheWriteInputTokens = cache_write` and `notionalUsd`. A row whose `notional_usd` exceeds
$100 for one turn is malformed and rejected. Cost reports prefer a
runtime-reported `notionalUsd` (labelled with its source) over catalog rates; there
is no built-in Grok rate card, but `paideia.cost-config.v1` `prices` can add one.
A broker limit failure is reported only as its closed `limit_reason`.

Request budget: `broker.limits.maxRequests` is enforced per broker turn by Daimon
and is the only request cap. Paideia adds no trial-level request limit; a trial's
upper bound is `(1 + external deliveries) × maxRequests`, with at most three
external deliveries. Token and time budgets remain bounded by the launch limits.
