# Status Folder

This folder owns the read-only `spawnfile status` status model, selectors, compile-report loading, and rendering.

## Structure

```text
src/status/
├── buildStatus.ts      # Builds static status observations from OrganizationView and compile report data
├── compiledContainerObservations.ts # Compile-report container/runtime/network artifact observations (blanket ok per instance/room, no cross-check)
├── compiledProbeCollection.ts # CLI-facing glue for lifecycleProbes.ts + moltnetWiringProbes.ts: real/stub readFile + one combined collector (B38)
├── compileReport.ts    # Defensive compile report loader for old and new report shapes; also parses moltnetNodePlans + entrypointPath (B38)
├── deploymentLogs.ts   # Redacted Docker log tail observations for status --live --logs
├── deployments.ts      # Deployment record summaries and optional live unit inspection
├── index.ts            # Barrel exports
├── lifecycleProbes.ts  # OFFLINE agent-lifecycle cross-check probes over the compile report (B38)
├── moltnetProbes.ts    # Public Moltnet health-only reachability probes (status --live)
├── moltnetWiringProbes.ts # OFFLINE Moltnet node-config/control-url/network/membership cross-check probes (B38)
├── renderStatus.ts     # Pretty, quiet, and JSON status renderers
├── selectionSubjects.ts # Expands selectors to related runtime, room, member, and deployment subjects
├── runtimeProbes.ts    # Adapter-owned runtime probe collection for status --live
├── selectors.ts        # Agent/team/network/runtime selector resolution
├── traversal.ts        # OrganizationView traversal helpers
└── types.ts            # Status model and command-result types
```

## Rules

- Keep status static/offline by default.
- Live inspection must be opt-in, bounded, and mediated through deployment helpers.
- Logs must stay opt-in and redacted. Status never exposes a raw-log mode.
- Do not call generated runtime CLIs here. Runtime health must go through adapter-owned probes and deployment-manager gateways.
- Moltnet live status is health-only: it does not authenticate, parse provider
  metadata, or report rooms, agents, membership, capabilities, or connections.
  Those guarantees belong to provider-owned status integration (B149).
- Treat `OrganizationView` as the graph projection source of truth; do not rebuild a parallel source graph from manifests.
- Compile reports are optional. A missing report is `unknown`, while malformed or unreadable reports are input failures.

## Offline lifecycle + Moltnet-wiring probes (B38)

`compiledContainerObservations.ts` stamps a blanket `ok` per compiled runtime
instance/room without cross-checking anything — it just says "this thing is
present in the report". `lifecycleProbes.ts` and `moltnetWiringProbes.ts`
are a different, stricter layer: OFFLINE cross-check probes that assert
specific facts about compiled artifacts (a runtime instance actually covers
every agent node, a Moltnet node config actually parses and points at a real
server, a generated Pi app actually exposes the B62 fail-closed operator
wake route). Both are pure functions — no direct `node:fs` access — that
take the already-`loadCompileReport`-ed report plus an **injected**
`readFile: (path: string) => Promise<string | null>`. This keeps them
hermetic and lets `compiledProbeCollection.ts` drive them with either a real
disk reader (`status --out <dir>`) or a stub that always resolves `null`
(home-deployment status, which has no on-disk compiled output tree at all).

**Cardinal rule, same as `src/audit/`: absent input is `unknown`, never
`ok`.** A probe that has nothing to check — no compile report, no compiled
output directory, an unreadable/missing file, a non-pi runtime for the
pi-only wake-operator check, or a compile that simply never declared
Moltnet — reports `unknown` (or, for `moltnetWiringProbes.ts`, legitimately
emits zero observations for a key when the compile report itself declares
zero Moltnet node plans/servers — there is nothing to enumerate, not a
missing-evidence case). It never goes silent by claiming `ok`, and it never
crashes `spawnfile status`.

New `spawnfile.status.v1` observation keys (all `source: "compile_report"`):

- `lifecycle.instance.coverage` (subject: `agent:<id>`/`team:<id>`) — every
  compile-report agent node id appears in some `runtimeInstances[].nodeIds`.
  Absent → `error`.
- `lifecycle.instance.runtime` (subject: `runtime-instance:<id>`) — the
  instance's `runtime` name resolves via `getRuntimeAdapter`
  (`src/runtime/registry.ts`). Unknown adapter name → `error`.
- `lifecycle.instance.paths` (subject: `runtime-instance:<id>`) — `configPath`
  missing → `error`; `homePath`/`workspacePath` missing → `warn`.
- `lifecycle.wake.operator` (subject: `runtime-instance:<id>`, B62) — for
  pi/daimon instances only, reads the emitted `runtime/app.mjs` under
  `<out>/container/rootfs${RUNTIME_INSTALL_ROOT}/<runtime>/app.mjs`
  (`src/runtime/container.ts`'s `RUNTIME_INSTALL_ROOT`, a runtime-scoped —
  not per-instance — install root; see `src/runtime/pi/adapter.ts:106`) and
  asserts it contains the `/spawnfile/agents/` operator route,
  `SPAWNFILE_PI_CONTROL_TOKEN`, and the fail-closed rejection text
  (`src/runtime/pi/appControlSource.ts`). Unreadable file → `error`;
  non-pi/daimon runtime → `unknown` ("not checked"); no compiled output
  directory at all → `unknown`.
- `lifecycle.run_id` (subject: `compile`, B93) — the compiled
  `container/entrypoint` script (`entrypointPath` on the loaded report)
  contains a `NOOPOLIS_RUN_ID=` assignment
  (`src/compiler/containerEntrypointRender.ts`, only rendered when the
  compile-host process env carried a run id). Every non-match case —
  missing entrypoint path, unreadable file, or no `NOOPOLIS_RUN_ID=`
  substring — is `unknown` with message `"not compiled with a run id"`,
  **never** `ok`.
- `network.wiring.node_config` (subject: `network:<networkId>`) — each
  `container.moltnet.node_plans[]` entry's `config_path` (a
  container-absolute path; physically resolved under
  `<out>/container/rootfs<config_path>`) parses as JSON with
  `version: "moltnet.node.v1"` (`src/compiler/moltnetNodeConfig.ts`).
  Unreadable/malformed/wrong-version → `error`.
- `network.wiring.control_url` (subject: `network:<networkId>`) — for each
  parsed node config's attachment, a `pi`-kind runtime (pi and daimon both
  lower to `kind: "pi"`, `src/compiler/moltnetRuntimeConfig.ts:108`) must
  have a `control_url` matching
  `^http://127\.0\.0\.1:\d+/agents/[a-z0-9-]+/wake$`; a `picoclaw`-kind
  runtime must have a non-empty `config_path`. Other kinds are not checked
  here. Malformed/missing → `error`.
- `network.wiring.network_resolves` (subject: `network:<networkId>`) — each
  node plan's `network_id` matches some `moltnetServers[].networkId` from
  the same compile report. Miss → `error`.
- `network.wiring.membership` (subject: `room:<networkId>:<roomId>`) — each
  `server_plans[].rooms[].members` id maps to a parsed node config
  attachment's `agent.id` in the same network (they share one identifier
  space — see `src/compiler/moltnetRoomMemberships.ts`'s `memberId`). Orphan
  member → `warn`.

`compileReport.ts` extends `StatusReport` with two new **optional** fields
(optional, like `moltnetServers`, so pre-B38 fixtures/constructors elsewhere
in this folder — e.g. `runtimeProbes.test.ts`, `moltnetProbes.test.ts` —
keep constructing a valid `StatusReport` without updating): `entrypointPath`
(absolute physical path to the compiled entrypoint script, resolved against
the actual output directory a given `loadCompileReport` call was handed —
never the report JSON's own possibly-stale `output_directory` field) and
`moltnetNodePlans` (parsed `container.moltnet.node_plans[]`, container-
absolute `configPath` not yet resolved onto disk). `imageStatusReport.ts`
sets both to `null`/`[]` for a home-deployment/image status, since there is
no on-disk compiled output tree to read there at all.

`src/cli/statusCommand.ts` calls `collectCompiledProbeObservations`
(`compiledProbeCollection.ts`) after `loadCompileReport`/
`loadedImageCompileReport` on **both** CLI paths and passes the result into
`createStaticStatus`'s new `compiledProbeObservations` option
(`buildStatus.ts` merges it straight into `observations`, right after the
existing compiled-report observations). The static path (`--out <dir>`
present) uses `readCompiledProbeFile`, a real disk reader that resolves
`null` instead of throwing on any unreadable path. The home-deployment path
(no output directory) uses `unavailableCompiledProbeFile`, which always
resolves `null` — there is no compiled output tree to read there at all, so
every probe that needs disk access reports its own defined `unknown`.
`StatusCommandLiveHandlers.compiledProbeCollectors` lets tests inject fake
`collectLifecycleProbeObservations`/`collectMoltnetWiringProbeObservations`
implementations without touching the real filesystem.
