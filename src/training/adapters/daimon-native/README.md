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
alone cannot complete a trial. Native metering retains cached-input tokens.

Real MCP/Moltnet receipts yield partial tool observations; unobserved arguments
and built-in tools remain absent. Native attention final prose is absent. Projects
can evaluate authentic filed artifacts through their own collectors. Missing
usage remains unknown. The terminal evidence retains preparation receipts.

Cancellation requests native stop, then stops/kills the owned labeled container
and independently verifies removal. Unknown containment never becomes confirmed.
Evaluator files are excluded from projections, and native Codex protection denies
runtime controls and engine credentials. Prepared memory must be fresh local state;
this adapter does not create or copy historical memory.

Only single-turn Codex attention with the workspace-no-network policy is supported.
Other engines, plain Pi equivalence, multi-wake conversations, complete built-in
tool traces and final-output capture are unsupported. Unit host/command doubles
test wiring and rejection paths; they are not authenticated native acceptance.
