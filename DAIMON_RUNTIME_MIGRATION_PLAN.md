# Spawnfile → Daimon runtime migration plan

## Objective

Replace the current `runtime: daimon` alias to Spawnfile's generated Pi
application with one compiled Daimon organization-runtime configuration and
one `daimon-runtime` process in the existing shared Daimon container. Spawnfile
continues to compile the organization graph, workspaces, Moltnet topology,
schedules, credentials and deployment; Daimon owns every agent turn, engine
process, engine authentication home, MCP lifecycle and process cleanup.

This is an ecosystem migration only. No Clank & Slop source, terminology,
personas, fixtures or publication behavior enters Spawnfile or Daimon.

## Contract fixed by the current Daimon release

Target the public package contract in `@noopolis/daimon@0.2.0`:

- package export: `@noopolis/daimon/runtime`;
- executable: `daimon-runtime`;
- config: `noopolis.daimon.organization-runtime.v1`;
- host fields: `bindHost`, `port`, `controlTokenEnv`;
- agent fields: `id`, `name`, `instructions`, `workspacePath`,
  `runtimeHomePath`, `engine.kind` (`codex`, `grok`, `agy` only);
- runtime control API: authenticated `/v1/wake`, `/v1/health`, and
  `/v1/activity`.

The v1 host limit is 32 agents. The new Daimon target builder must count all
resolved `runtime: daimon` agents before emitting any file and reject 33 or
more with the deterministic diagnostic:

```text
Daimon organization runtime v1 supports at most 32 agents; found <count>. Split the organization across explicit runtime boundaries.
```

It must never silently shard, create multiple Daimon targets, alter the
organization graph, or treat nested teams as a reason to bypass the count.
Add unit coverage for 32 accepted and 33 rejected agents, asserting the exact
diagnostic and no partial target/config emission.

The config is deliberately strict. It contains no schedules, Moltnet
configuration, commands, environment maps, secret values, MCP declarations,
provider traffic, organization graph or deployment data.

## Current ownership to retire

`src/runtime/pi/adapter.ts` currently exposes `daimonAdapter` as
`{ ...piAdapter, name: "daimon" }`. That makes `runtime: daimon` compile the
same generated Pi application as `runtime: pi`.

The following Daimon-alias behavior must be removed from the Daimon path, not
ported:

- generated `pi-app.json`, `runtime/app.mjs`, `runtime/schedule.mjs`, models
  config and Pi control/activity servers in `src/runtime/pi/appTemplate.ts`,
  `containerTargets.ts`, `appSource.ts`, `appCoreSource.ts`,
  `appControlSource.ts`, `appActivitySource.ts`, and `appScheduleSource.ts`;
- generated Codex/Grok/AGY execution, prompts, output files and child process
  handling in `appCliEnginesSource.ts` and its helpers;
- generated engine auth copying/staging and engine-home construction in
  `src/runtime/pi/runAuth.ts`;
- Pi-specific engine, models, tool, raw-capture and schedule option lowering
  in `appAgentConfig.ts`, `appTemplateTypes.ts`, and `appScriptedEngine.ts`.

Those files remain available only for an explicit legacy `runtime: pi` path
until a separately approved removal. They must not be imported by the new
Daimon adapter. `openclaw` and `picoclaw` are untouched.

## Implementation slices

### 1. Add an independent Daimon adapter

Create `src/runtime/daimon/` with its own `AGENTS.md` and `CLAUDE.md` symlink:

- `adapter.ts`: validate the closed Daimon engine choices, reject unsupported
  Pi-only options, compile documents/skills into the agent workspace, and
  advertise only capabilities Daimon's public contract supports.
- `organizationConfig.ts`: pure lowering from resolved agent nodes plus
  resolved container paths to the exact v1 config. Use the public version
  literal and a local structural type mirror; do not import Daimon source or
  internals.
- `containerTargets.ts`: group all `runtime: daimon` agents into a single,
  stable target (for example `daimon-org`); emit only
  `daimon-runtime.json` plus workspace files. It must never emit an app,
  generated engine runner, generated MCP server, or generated auth script.
- `auth.ts`: declares the minimal per-agent mount destinations expected by
  Daimon (`.codex/auth.json`, `.grok/auth.json`, or
  `.antigravity-cli/antigravity-oauth-token`) but does not parse, copy,
  transform or log credentials.
- focused tests beside every module, including a two-agent mixed-engine fake
  config assertion and rejection matrices.

Replace the current `daimonAdapter` export in `src/runtime/pi/adapter.ts` with
the new adapter imported from `src/runtime/daimon/adapter.ts`; keep `piAdapter`
as a distinct legacy adapter. Update `src/runtime/registry.ts` only as needed
to register the separate implementation.

### 2. Compile physical paths before config serialization

`src/compiler/containerTargetPlanResolution.ts` currently derives one target
home/workspace path. Extend the Daimon target shape so each agent receives a
unique pre-created pair under the single target, for example:

```text
/var/lib/spawnfile/instances/daimon/daimon-org/workspace/agents/<slug>
/var/lib/spawnfile/instances/daimon/daimon-org/runtime-homes/<slug>
```

`src/runtime/daimon/organizationConfig.ts` consumes these final absolute
paths. The entrypoint creates them before `daimon-runtime` starts, with
workspace-safe permissions and exact `0700` runtime-home permissions, never
after the host has started. Update `containerArtifactsTypes.ts`,
`containerArtifactsPlans.ts`, `containerTargetResources.ts`, and their tests
only to carry this per-agent path data; do not add an organization graph to
Daimon configuration.

Keep existing resource links and per-agent workspace relocation. Update
`daimonTelemetryArtifacts.ts` to mount Daimon's actual per-agent telemetry
locations only after confirming the public runtime's telemetry contract; do
not retain the old generated-Pi path by assumption.

### 3. Container recipe, pin and entrypoint

Introduce a source-free, separately versioned **generic Daimon runtime
distribution**. It is built outside a customer/org compile from one reviewed
release recipe and contains exactly the public `@noopolis/daimon` package plus
the reviewed Codex, Grok and AGY CLI installations required by that Daimon
release. It contains no organization source/configuration, workspace content,
credentials, browser state, Moltnet configuration, provider invocation, or
agent behavior.

For every generic-image release, publish an immutable image digest and a
machine-readable capability receipt containing at least: Daimon package
version, engine executable canonical identities, bounded local
`--version`/capability digests, supported engine kinds, architecture and
build/provenance identity. The release build verifies all three local CLI
capabilities without performing a model/auth turn. The image has a generic
health command that proves the installed `daimon-runtime` binary and its
declared capability receipt agree; it does not start an organization.

`runtimes.yaml` must pin the image by immutable digest plus the matching
receipt identity (not a mutable tag). Spawnfile selects/verifies this identity
at build/deploy and records only public image/receipt identifiers. It never
installs a CLI, chooses CLI argv, probes provider auth, reads an auth home, or
executes an engine. `runtime-images/daimon/Dockerfile` becomes the generic
distribution build recipe rather than a per-org workaround; the release
pipeline owns build, update, provenance and capability verification.

The local-development override remains an explicit test/development seam only:
it supplies a built generic runtime image plus matching receipt, is rejected
when digest/receipt/version/capability identity disagrees, and is never inferred
from sibling source checkouts. Recovery resolves the exact recorded immutable
image/receipt pair from the deployment record; it never rebuilds, pulls
`latest`, scans a checkout, or substitutes an engine installation.

Update these synchronized release identities to Daimon `0.2.0` and the new
generic image release identity:

- `runtimes.yaml` (`ref`, image tag);
- `runtime-images/daimon/Dockerfile` build arg/default install;
- `package.json` `runtime:daimon-image` script;
- `src/runtime/container.ts` Daimon package version/install recipe;
- specs and tests that name `0.1.2`.

The generated organization image copies the pinned generic runtime artifact
only. It must install no Codex/Grok/AGY CLI packages and run no provider
installer. Daimon itself resolves, verifies and invokes those engines at
runtime.

Set the new adapter's container metadata to start:

```text
daimon-runtime run --config <instance-root>/daimon-runtime.json
```

Update `containerEntrypointRender.ts` so the Daimon target receives only:

- canonical config path;
- one generated control-token env name/value;
- its port/bind wiring;
- per-agent physical-root preparation;
- opaque credential mounts/materialization supplied by Spawnfile's auth
  layer;
- existing workspace-resource and Moltnet node setup.

It must not set engine command arguments, engine model knobs, broad inherited
environment maps, or credentials in JSON/config files. Update readiness
waiting to recognize Daimon's `/v1/health` contract instead of Pi `/healthz`.

### 4. Auth boundary migration

Replace `preparePiRuntimeAuth` use for `runtime: daimon` with the new
Daimon-specific preparation API. Spawnfile remains responsible for selecting
the user-authorized credential source and mounting it into the pre-created
per-agent root, but it may only materialize the exact minimal artifact for the
selected engine.

Required changes:

- add strict per-engine credential-source/mount planning in `src/auth/` and
  `src/runtime/daimon/auth.ts` without expanding general auth authority;
- use the existing ephemeral run-auth directory lifecycle in
  `src/compiler/runProjectAuth.ts` and `runProjectLifecycle.ts` so detached
  containers keep needed bind sources and cleanup remains safe;
- never recursively stage host homes, browser state, config files, MCP state
  or cookies;
- preserve the existing Pi auth preparer for explicit `runtime: pi`,
  OpenClaw and PicoClaw unchanged;
- test only fake JSON artifacts and assert no secret bytes/path leak into
  reports, Docker labels, emitted config or receipts.

The current Daimon v1 engine set has no `pi`, `scripted`, Claude, arbitrary
endpoint, model, tool or MCP config. `runtime: daimon` must reject those
requests with a clear migration diagnostic rather than silently lowering them
to Spawnfile code. Existing scripted fixture coverage stays on `runtime: pi`
until Daimon publishes an explicit compatible contract.

### 5. Moltnet and schedules without cognition in Spawnfile

Keep all existing Moltnet topology compilation in compiler modules. Adapt the
generated Moltnet node delivery URL/body to Daimon's authenticated `/v1/wake`
wire contract and generated control-token environment binding. The bridge
continues to decide delivery; Daimon only receives targeted wakes.

Schedules require an explicit compatibility decision before implementation:
the strict v1 Daimon config intentionally has no schedule field. Do **not**
smuggle schedules into it. The migration will add a deterministic Spawnfile
schedule-delivery sidecar/entrypoint component only if it can send the same
typed authenticated wake requests without creating agent turns, selecting
work, or reading agent state. It remains Spawnfile schedule ownership; Daimon
owns execution. If that component is not ready in the first slice,
`runtime: daimon` accepts `disabled` schedules only and fails other schedules
at compile time. The current generated Pi schedule runner must not survive on
the Daimon path.

### 6. Reports, status, artifacts and developer tooling

Update only the Daimon-facing consumers of generated Pi paths:

- `src/compiler/upReceipt.ts`, report types and `engine_by_node_id` disclosure
  to read the Daimon target's engine map;
- Daimon status probes and `src/dev/*` Pi-only config/activity/hot-apply code
  to either add a narrow Daimon control-client implementation or explicitly
  retain Pi-only behavior; no generic Pi fallback for Daimon;
- `src/e2e/daimonRuntimeInstanceLookup.ts`, `daimonOrg.ts`, memory integration
  and artifact export paths to the public runtime configuration/health/activity
  behavior;
- `specs/RUNTIMES.md`, `CONTAINERS.md`, `SURFACES.md`, runtime docs and
  `website/src/content/docs/runtimes/daimon.md` to describe the real boundary.

No changes are required to Simfile's public contract. It continues using
Spawnfile CLI receipts/artifacts and never imports either runtime.

### 7. Compatibility and deletion order

1. Land the standalone Daimon adapter and target config with no change to
   `runtime: pi`.
2. Switch only `runtime: daimon` to it; preserve source manifests using that
   runtime name, with documented option rejection where v1 lacks support.
3. Update `examples/daimon-org` to use Codex/Grok/AGY declarations supported
   by Daimon and remove its generated-Pi-specific assertions.
4. Keep explicit `runtime: pi` as temporary compatibility for existing
   scripted/Pi consumers; mark it deprecated only in a separate release after
   an inventory of consumers and a migration guide.
5. Delete only Daimon-alias imports/tests/generation branches after compile,
   E2E and package consumers use the new adapter. Do not delete shared Pi
   sources while `runtime: pi` exists.

## Verification graph

Run focused deterministic gates first:

1. Pure config lowering validates against the public v1 schema and exact
   config parser in a packed/installable Daimon package fixture.
2. Compile a two-agent fake organization (Codex + Grok) into exactly one
   Daimon target/config, unique real roots, no engine commands/auth values,
   no generated Pi/CLI/MCP source, and one daemon start command.
3. Generic runtime-distribution tests verify the immutable image/receipt pair,
   exact Daimon/CLI capability identities, source-free contents, local override
   mismatch rejection and recovery from only recorded immutable identities.
4. Fake host E2E uses only fake executable/auth fixtures: start one
   `daimon-runtime`, send two authenticated wakes, prove same-agent serial
   execution/cross-agent concurrency, health/activity responses, and full
   shutdown with no listener/child survivor.
5. Compile tests prove Moltnet bridge delivery shape and schedule behavior
   selected in Slice 5, without live provider traffic.
6. Auth tests prove per-agent minimal mounts, exact mode expectations and no
   credentials in reports/receipts/logs.
7. Run Spawnfile typecheck/unit/package closure; then a Docker fake-engine
   E2E with a bounded external watchdog and post-run process/listener
   inventory. Real subscription and browser checks happen only after these
   gates pass and remain opt-in.

## Non-goals

- No Spawnfile execution of Codex, Grok, AGY, provider adapters, MCP servers,
  agent prompts, process groups or model-auth home semantics.
- No Daimon import of Spawnfile compiler internals, Moltnet topology, schedule
  policy, workspace compilation or deployment records.
- No changes to OpenClaw/PicoClaw behavior.
- No live Docker/provider/login/push work during this planning slice.
