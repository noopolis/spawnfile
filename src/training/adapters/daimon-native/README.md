# Native Daimon attention trials

`createDaimonNativeAdapter()` runs one selected Codex attention agent through
Daimon's public organization control host in a fresh local Linux container. This
is separate from the existing Pi/session adapter. Paideia does not compile the
organization, rebuild the identity envelope, substitute fixture tools or implement
Mneme. Caller preparation supplies canonical native config and immutable code.

## Public entry points

- `@noopolis/paideia/adapters/daimon-native`: adapter, launch schema and types,
  plus `loadNativeLaunch` (receipt and path preflight, starts nothing) and
  `nativeTrialArtifactsRoot` (where a trial's private control artifacts land).
  Callers prepare against these rather than re-deriving either.
- `@noopolis/paideia/adapters/daimon-native/worker`: `runDaimonNativeWorker(args)`,
  plus `verifyNativeWorkerStartup(args)` and the three checks it composes
  (`parseWorkerArguments`, `assertNativeProfile`, `verifyWorkerPaths`).
  Importing this subpath never starts a worker. The separate built `worker/cli.js`
  file is the container CLI entrypoint when no project bootstrap is declared.
  `verifyNativeWorkerStartup` runs the worker's own startup validation in
  preparation — argument shape, compiled-config digest, launch receipt, profile
  agreement and the control path rules — leaving out only Daimon's
  `parseOrganizationRuntimeConfig`, which needs the installed runtime peer. The
  worker calls it too, so a rule cannot hold in preparation and fail at startup.

Preparation writes `native-launch.json` in the trial runtime home. The adapter
resolves that directory before deriving the receipt path, so a runner that reaches
a fixed container slot through a symlinked trial path still hands the worker a real
`--launch` path. Every other control path must be canonical in its own right: the
worker refuses a config, token file or control root whose path traverses a link. The strict
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

## Production transport delivery and task time

Both receipt versions accept optional `delivery: "direct" | "transport"`.
Omission retains the direct manual-wake behavior and old receipt shape. Transport
works with Codex and child-process Grok; the caller owns the real isolated Moltnet
server, its Daimon bridge, sender/room configuration and bootstrap lifecycle.

The worker's isolated Bearer token authenticates every route. In transport mode,
`POST /v2/wakes` uses Daimon's public `parseWakeAcceptanceRequest` and `host.accept`;
it returns Daimon's acceptance unchanged (202), including `acceptance_id` and
`request_digest`. Kind, text envelope and real `occurred_at` pass through unchanged.
The bridge follows `GET /v2/wake-receipts/<acceptance_id>` to terminal. Existing
`GET /v2/activity` and `GET /v2/availability` remain available. Direct mode refuses
`POST /v2/wakes` and the transport arming read with 404.

For a low-level caller:

1. Start `POST /trial/run` with `{wakeId, source, controls?}`. `source` is exactly
   `{kind: "transport", deliveryId: "moltnet:<message-id>"}` or
   `{kind: "transport", deliveryIdPrefix: "moltnet:"}`. `text` is optional and is
   never submitted to the native host in this mode.
2. Poll authenticated `GET /trial/run` until its `wakeId` and `source` match and
   `state` is `waiting` or `observing`; `idle` means no run is armed. Keep the POST
   open while observing.
3. Publish on the real transport. Only matching acceptances received after arming
   can bind; retries of earlier deliveries cannot become the new wake. Terminal
   sealing waits for in-flight admissions and repeats control/evidence reads if
   admission changes during collection. It also waits for every agent acceptance
   and activity row to be disposed and for native pending to be zero; unselected
   queued work cannot escape the trial. Before the first arm and once sealed, new native identities get
   HTTP 409 `{error: "transport_admission_sealed"}` before native admission until
   the next run arms; retries of actually accepted identities still reach Daimon
   for its own idempotency/conflict response. The POST
   returns terminal evidence, or a clear failure if the expected delivery never
   arrives before the real deadline.

Adapter callers provide `transportDelivery.prepare(context, signal)`, returning
`{source, publish(signal)}`. Preparation reserves the delivery identity; `publish`
is invoked only after the matching run is armed. Configure this alongside
`execution: {kind: "child-process"}` for shared-container transport. Deferred
continuations keep the existing `id`, `text`, and content-hashed `source` evidence,
and add `transport: {source, publish}`. That transport source must name an exact
message ID. At most three continuations share the original deadline. Providers
must honor cancellation and must not publish during preparation. Preparation and
publication share the real deadline. Eight seconds of terminal grace preserve
failure reports; success requires a valid worker completion timestamp before the
original deadline. Cancellation remains immediate.

Daimon owns inbox batching, dispositions, deferred items and clock projection.
Evidence keeps every selected delivery's receipt and execution history in
`transport.selectedDeliveries`, every observed batch and its availability budget
in `transport.batches`, and original producer envelopes in `transport.deliveries`.
The legacy `batch` remains the primary delivery's batch. Transport `native`
retains all trial execution traces and usage; every selected execution must have
a completed trace, observed batch membership and usage before success. A missed active batch
observation fails closed. `renderedAllowances: "unavailable-public-api"` is
deliberate: the inspected runtime computes allowances when the model calls
`daimon_inbox`; its public control API has no retained copy of that response.
Polling availability cannot establish what the engine saw. Exact rendered-budget
capture requires a public Daimon evidence export; Paideia does not recreate it.

`POST /v2/wakes` uses Daimon's 1,048,576-byte body limit. The worker decodes JSON
objects and applies the authenticated control token; `host.accept` owns schema
validation and its structured rejection response while admission is open. A sealed
run's lifecycle refusal takes precedence for all new identities. Native HTTP conformance tests
require the optional `@noopolis/daimon/runtime` package to be installed; they use
its real public parser/digest and rejection API, with a persistence double for
accepted retries. Core runtime use does not require the optional package.

Optional receipt `taskClock: {origin, anchorEpochMs, libfaketimePath}` selects an advancing task
clock. `origin` must be an ISO instant with `Z` or an explicit offset, within UTC
years 1970–9999. Trial preparation must sample real `Date.now()` once and supply
that safe-integer `anchorEpochMs` to both this receipt and the caller's Moltnet
server/bridge clock contract. The worker preserves the caller anchor exactly;
missing anchors are refused. At worker startup an anchor may be at most 1000 ms
in the future (clock-skew tolerance) and at most `--timeout-ms` old (the trial
deadline window), both inclusive. Prepare it near launch; an expired anchor fails
instead of resetting the shared clock.

The image supplies one `libfaketime*.so*` library path. The running worker sets
`NOOPOLIS_TASK_CLOCK` to `{version: "noopolis.task-clock.v1", origin, anchorEpochMs}`
unchanged from the caller's clock contract, and supplies `LD_PRELOAD` for Daimon's
child gate before creating the host. Never preload the worker through its launch
environment. Daimon and engines stay on real time; Daimon applies the advancing
offset only to supported tool/MCP children. Ready and per-wake frames record the
origin and anchor; every Paideia timeout remains real. Omission unsets the clock
environment. Supply a clock-capable Daimon runtime and, for brokered Grok, its
attested clocked worker configuration. No generic public runtime capability marker
currently proves clock support; live container verification remains required.
The inspected Daimon package does not publicly export its
`realTimeProcessEnvironment` stripping helper. Paideia's startup tests therefore
verify the installed contract and retained anchor, not downstream engine clock
stripping; that private behavior needs Daimon's own tests and live verification.

Producer delivery timestamps must remain real UTC milliseconds; Daimon shifts
them once at dispatch. Historical dates inside text remain unchanged. This
adapter leaves provider-prompt date correction to Daimon and preserves its observations.

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

Each wake's complete frame is already persisted as `evidence.<ordinal>.json`
beside the latest `evidence.json` in the private trial artifact root, and as an
operator-only diagnostic in the run's raw `events.jsonl`. Inspect
`native.modelContexts`, `native.requests`, and optional `native.turnSeals`.
Seals retain `provider_clock` counters and dates (recovery: `rows[].providerClock`).
Absence stays absent; this evidences broker rewriting, not provider delivery.
Prompts remain private; the inspected seal writer omits `cleanupDiagnostic`.

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

Closure requires idle native activity, acknowledged native stop, an observed clean
worker exit and observed disappearance of the owned process group. The worker's
`quiescence: unknown` / `parent-container-owner` frame is only a native stop
acknowledgement; the parent adapter derives the confirmed receipt after these checks.
Only ESRCH establishes group absence. The parent never signals after leader reap;
surviving descendants or denied inspection leave closure unknown. Cancellation,
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
| `projectionVersion`, `projectionSha256` | `noopolis.daimon.grok-broker-projection.v2` and the canonical digest the slot supervisor bound |
| `workerConfigVariant` | Required `unclocked` or `clocked`, passed unchanged to Daimon; `taskClock` requires `clocked` |
| `slot`, `workerUid`, `workerHomePath`, `architecture`, `usageLedgerPath`, `seccompProfileSha256`, `limits` | Passed verbatim to Daimon's `resolveOrganizationGrokBrokerProjection` |
| `evaluatorPaths[]` | `{role, path}` for `run-root`, `context`, `sealed-inputs`, `judge-home`, `slot-ledger` (the usage ledger directory); passed as the projection's `denyPaths` |
| `slotPreflightReceipt` | Input path contract: the root slot supervisor writes `noopolis.daimon.grok-slot-preflight.v2` here after provisioning or recycling the slot |
| `expectedNonce`, `minGeneration` | This trial's recycle freshness: the nonce Paideia sent with the recycle request and one above the last generation it accepted for the slot |

### Slot path contract (what preparation must produce)

A Grok launch runs inside the broker-capable training container, whose slot paths
are fixed and bound by `projection_sha256`; it cannot satisfy the Codex rule that
the control root and every writable root live inside the trial runtime home. The
adapter therefore takes the same guarantee from the container contract, and
preparation must produce exactly this shape:

| Member | Requirement |
|---|---|
| `workspace.source` | the trial workspace the evaluator passed as `workspacePath` (`/run/training/slot/workspace`) |
| `projections` | exactly one entry, role `home`, whose source is the trial runtime home the evaluator passed as `runtimeHomePath` (`/run/training/slot/runtime-home`) |
| `controlRoot` | a slot directory the supervisor's receipt denies to the worker uid, private (no group/other bits), outside the workspace (`/run/training/slot/state`) |
| `config`, `tokenFile`, `envFile` | canonical private files inside some denied slot root (`/run/paideia/...`), never inside the workspace |
| `native-launch.json` | written `0600` in the trial runtime home; for Grok that directory is the subject's own home |
| `slotPreflightReceipt` | a canonical `0640`-or-tighter file owned by the container root, whose `projection_sha256` equals `broker.projectionSha256` |

A declared Mneme root is admitted by containment, not by its own projection: a
Grok launch projects one root, so preparation materializes the store inside the
runtime home (`<slot runtime home>/paideia/memory`) and the profile check accepts
any root strictly inside `runtimeHomePath`. A root equal to the runtime home, or
outside it, is still refused, and Codex keeps its separate fresh `memory`
projection unchanged. Containment is safe here because the home is already wholly
writable, digest-bound and inside the subject's reach, so a place inside it grants
nothing new — and it is fresh per trial, because the slot supervisor's recycle
wipes the runtime home whole. Nothing else is bound to a projection role: the
adapter never ties `moltnet`, `mcp`, tool state or the acceptance store to one.

The trial runner stays engine-neutral and keeps protecting its own layout,
including the runtime home it allocated. For a Grok slot that root is the
subject's own home, so the adapter — the only layer holding the receipt, the
projection digest and the closed writable set — exempts exactly the two
digest-bound subject roots from the caller's protected set, at load and again in
the parent slot preflight. A caller cannot both hand the subject a root and
demand the subject be denied it. Nothing else is exempt: a protected path
*inside* a subject root is still refused, and a Codex launch has no exemption at
all.

Before any process starts the adapter reads that receipt and refuses a launch
whose control root or control inputs are not inside a denied canary root, whose
writable roots are anything but those two evaluator-named directories, or whose
writable roots touch a denied root. Both writable roots are then bound by digest:
Daimon's resolved projection must carry them as `workspacePath` and
`runtimeHomePath`, `source` must equal `target` for child execution, and the
projection's canonical digest must equal `broker.projectionSha256` and the slot
receipt. Nothing the launch chose on its own is writable, which is the property
the Codex runtime-home anchor provides.

### Per-trial control artifacts

The slot control root is fixed, shared between trials and already holds Daimon's
wake-acceptance store, so it is never empty and the supervisor's recycle — which
wipes that store, the worker home, the slot workspace, the turn store and the
per-slot ledger — deliberately does not clear it. Paideia owns exactly one
subtree of it and separates trials there itself:

```
/run/training/slot/state/
├── wake-acceptance/                     Daimon's, wiped by every recycle
└── paideia-trials/trial-<sha256(trialId)[0:32]>/
    ├── sandbox-projection.json          Daimon's runtime acceptance store,
    ├── child-sandbox-preflight.json     the wake fuse directory and the
    ├── child-diagnostics.json           `--evidence` file also live here
    ├── evidence.json                    the latest delivery's terminal frame,
    ├── evidence.1.json                  and one file per wake by delivery
    └── evidence.2.json                  ordinal, never renamed over
```

A trial that defers runs several wakes and each publishes its own terminal frame.
`evidence.json` is renamed over on every delivery, so the numbered files beside it
are what keeps an earlier wake's account: nothing is merged and each file holds
exactly one wake's frame, naming its own wake.

The directory is created once per trial with a non-recursive `mkdir`, so a
repeated trial identity fails with `EEXIST` instead of colliding with, or
silently overwriting, the previous trial's exclusive (`wx`) artifacts, and a
stale artifact can never be read as this trial's. The leaf name is a digest of
the trial identity, so a caller-supplied identity cannot escape the control root.
Only the deny mask Daimon lifts stays the control root itself — that is the value
`projection_sha256` binds, and it must not become the per-trial directory. Codex
control roots are already per trial and are used unchanged.

A trial's Daimon runtime acceptance store and wake fuse directory are that same
per-trial directory, so an acceptance from trial N cannot be replayed into trial
N+1 whatever a recycle does. The container's provisioned `<state>/wake-acceptance`
stays the supervisor's own store and recycle target; it is not where a Paideia
trial accepts, and the wipe target does not need to widen to the state root. If it
ever did widen, it would have to stay between trials, never during one.

Startup, in order, with no model call and no `codex sandbox` process:

1. The worker loads Daimon's Grok exports (`resolveOrganizationGrokBrokerProjection`,
   `grokBrokerProjectionSha256`, `verifyGrokSlotPreflightReceipt`) and fails closed
   if any is missing. The config must declare the same model and effort and no
   Codex sandbox; broker token limit must not exceed the launch wake ceiling.
2. The resolved projection's canonical digest must equal Daimon's digest and the
   launch receipt; wake timeout/token overrides are capped by its registered limits.
   Shorter trial deadlines lower the wake timeout. Codex is unchanged. The worker variant,
   model/effort config pin and clock metadata must match; both v2 variants have
   offline parity coverage against Daimon's public resolver. Linux shell-clock
   operation still requires the provisioner's native container verification.
3. The slot receipt must exist and pass Daimon's verifier (exact deny-path canaries,
   profile, seccomp, executable, and freshness: the launch nonce and a generation
   of at least `minGeneration`; v1 receipts are refused). Paideia then requires the control root and every
   evaluator root to be an exact denied canary and the config/token/env files to
   sit inside a denied root, and persists `sandbox-projection.json`.
4. The ready line adds `engine` and `reasoningEffort`; the parent requires them to
   match the launch. The parent re-binds the persisted receipt without Daimon and
   additionally requires every caller `protectedPaths` entry as a denied canary.
   Child execution must supply `grokSlots`. The CLI owns it: one
   `createExperimentSlotFreshness(out)` store per experiment, handed to the
   integration's `createAdapter` (for `grokSlots`) and preparation hooks
   (`NativeTrialServices.grokSlots`). `prepareNativeSubject` calls `request(slot)`
   before the provisioner runs to mint the nonce and generation floor the
   provisioner sends with the recycle request and echoes into the launch;
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

### Consumer child bootstrap

`<launch.workerRoot>/worker/cli.js` is the supported child worker entry. A consumer bootstrap can spawn it with the worker arguments returned by `nativeChildArguments`, replacing only the bootstrap entry path. Preserve the explicit environment and owned-process containment. The `worker` module index is an import seam and does not start a worker.

`SubjectTurnResult.evidence` contains adapter-owned `NativeTurnEvidence` when a frame was admitted. Its ordered `wakes` retain each closed execution, all execution IDs attributed by that frame and its worker-admitted trial ledger (including revisits), and the runtime-local protected per-wake file path. Paths in container execution belong to that container; they do not imply host accessibility. `PreparedTrial.collect(outcome?)` receives returned turns only; live collection may receive no outcome or a partial set.
