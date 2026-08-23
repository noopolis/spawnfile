# Spawnfile

> A spec and compiler for autonomous agent runtimes. Write your agent once, compile for any runtime.

<p align="center">
  <a href="https://www.npmjs.com/package/spawnfile"><img src="https://img.shields.io/npm/v/spawnfile?style=flat-square&color=d4604a&label=npm" alt="npm"></a>
  <a href="https://www.npmjs.com/package/spawnfile"><img src="https://img.shields.io/npm/dm/spawnfile?style=flat-square&color=d4604a" alt="downloads"></a>
  <a href="#from-source"><img src="https://img.shields.io/node/v/spawnfile?style=flat-square&color=d4604a" alt="node"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/spawnfile?style=flat-square&color=d4604a" alt="MIT"></a>
  <a href="https://spawnfile.com"><img src="https://img.shields.io/website?url=https%3A%2F%2Fspawnfile.com&style=flat-square&label=spawnfile.com&color=d4604a" alt="website"></a>
</p>

<p align="center">
  <img src="website/public/new-claw-images.png" alt="Spawnfile compiles one agent source into multiple runtimes" width="420" />
</p>

Spawnfile is a **portable source format** for autonomous agents and teams. You write one canonical project — identity docs, skills, MCP connections, model and sandbox intent, team structure, and declared communication surfaces — and `spawnfile compile` lowers it into the runtime-specific config and workspace each adapter needs.

It's not a runtime-to-runtime translator. The compiler starts from the canonical source, emits each declared adapter's output, and reports per-capability support as `supported`, `degraded`, or `unsupported`.

Pairs with [**Moltnet**](https://moltnet.dev) as the first provider for `team.networks[]`, letting compiled agents share declared rooms, DMs, and history across runtimes without Spawnfile injecting its own message router.

For a Simfile linked to a Spawnfile, the product entrypoint is owned by
Simfile:

```bash
simfile run ./Simfile --view
```

That command delegates only organization lifecycle operations to Spawnfile's
public CLI and versioned receipts. Spawnfile prepares target resources,
deploys the organization, records the pinned Pi-bridge Moltnet identity,
exports evidence, and cleans up; it does not carry simulation behavior or
trigger cognition. The world reaches paused/pristine readiness first, the
organization starts second, and one attested activation releases independent
world ticks and organization-owned schedules. A separately manifested
`simfile.world-decision-claim.v1` capability may extend the base world-sidecar
ABI without changing it. See
[`specs/ECOSYSTEM_RUNTIME_BOUNDARIES.md`](specs/ECOSYSTEM_RUNTIME_BOUNDARIES.md)
for ownership and [`specs/TARGETS.md`](specs/TARGETS.md) for target, auth,
Moltnet pinning, recovery, and cleanup contracts.

## Install

```bash
npm install -g spawnfile
spawnfile --version
spawnfile --help
```

Node.js 22+ required. See [source install](#from-source) for local development.

## The happy path

```bash
spawnfile init                                   # scaffold an agent (defaults to openclaw)
spawnfile init --list-templates                  # list bundled example templates
spawnfile init --template mixed-runtime-org      # scaffold from an example org
spawnfile validate                               # check the graph
spawnfile view .                                 # read-only graph view; writes no files
spawnfile compile                                # lower to runtime-native output
spawnfile status .                               # read declared/compiled status
spawnfile auth sync --profile dev --env-file .env
spawnfile build  --tag my-agent                  # compile + docker build
spawnfile up . --context gpu-host --detach       # build and run on a Docker context
spawnfile dev up . --auth-profile dev            # detached dev loop in .spawn-dev
spawnfile dev apply . --agent researcher         # hot-add/reload one Pi agent
spawnfile dev activity . --agent researcher      # inspect buffered Pi activity events
spawnfile run    --tag my-agent --auth-profile dev --detach
spawnfile status . --live                        # inspect the detached deployment
spawnfile publish . --tag you/my-agent:1.0.0     # compile + build + verify + push
```

Compiled output lands under `.spawn/` by default, including a `Dockerfile`, `entrypoint.sh`, `.env.example`, and a prebuilt `container/rootfs/` tree. `spawnfile build` uses the pinned runtime artifacts from `runtimes.yaml`; it does not rebuild runtimes from source. Daimon, OpenClaw, and PicoClaw use published copyable artifact images by default, so normal prompt/config edits reuse their dependency layers. Daimon accepts only its exact immutable image digest plus matching capability receipt; mutable/local overrides are fail-closed. OpenClaw and PicoClaw retain their explicit local-image overrides. For `build`/`up` on a docker `--context`, Moltnet release assets are staged for that context's architecture (`amd64` or `arm64`); for local-only manual compile targeting a fixed architecture, set `SPAWNFILE_MOLTNET_TARGET_ARCH=amd64|arm64`.

`spawnfile status` is read-only. By default it shows authored and compiled state without Docker, runtime, or Moltnet calls. With `--live`, it reads the selected detached deployment record, inspects the recorded Docker target, runs adapter-owned runtime probes, and checks Moltnet metadata without reading message bodies. Add `--logs` for a redacted Docker log tail, or `--watch` to refresh status continuously. For a remote Docker context where the local record is missing, pass `--context <name>` with `--live` to recover the deployment from Spawnfile container labels.

`spawnfile dev` is the source-backed interactive loop. In Phase A, hot apply and its bounded activity buffer remain `runtime: pi` behavior; public `runtime: daimon` hosts do not yet support hot apply, schedules, MCP, or agent surfaces. A future control-plane adapter will integrate those concerns through Daimon's public APIs rather than generated Pi code.

Before automating Spawnfile, query the installed CLI rather than inferring
support from its package version:

```bash
spawnfile capabilities --json
```

This command only reads Spawnfile's packaged version and emits one strict
`spawnfile.capabilities.v1` JSON document. It does not read standard input,
write files, or contact Docker. The receipt identifies the target resolver,
closed composed-lifecycle command set, optional model-auth behavior, local
evidence helper, and typed terminal-artifact absence contracts. Capabilities
describe the installed CLI surface; target and auth preflight can still fail
for a particular machine or project. See
[`specs/TARGETS.md`](specs/TARGETS.md#capability-discovery).

For a local Docker target, Spawnfile prepares and journals the package-owned
helper under its private target state:

```bash
# node:22-bookworm-slim must already be present in this Docker context.
spawnfile helper prepare-evidence-export \
  --context default \
  --json

spawnfile target resolve_config \
  --context default \
  --evidence-destination "$PWD/.spawn-local/evidence.tar" \
  --prepare-evidence-helper
```

The helper command uses only the explicitly named local context, performs a
network-disabled build from package-shipped source, never pulls or pushes, and
keeps a fsynced pending transaction authority before its first Docker mutation.
The public result is only a versioned opaque handle and digest; reuse re-attests
the exact context, daemon, base config, platform, recipe, and image config
identity. No registry manifest or caller-managed authority file is required.

Compiled images are self-describing: `spawnfile publish` pushes one to any OCI registry, and anyone can run it with no source — `spawnfile up you/my-agent:1.0.0 --deployment prod --detach --auth-profile me` — or inspect what it needs first with `spawnfile status you/my-agent:1.0.0`. See [`specs/DISTRIBUTION.md`](specs/DISTRIBUTION.md).

### Target adapter CLI

`spawnfile target` is the explicit, non-interactive target-adapter boundary for
an external orchestrator. It takes one absolute request JSON file and one
strict private configuration object on standard input — never a configuration
path or inline configuration:

```bash
target-config-producer | spawnfile target --config - create_data_network /absolute/path/request.json
```

On success it writes exactly one canonical JSON receipt followed by a newline.

For a crash-safe machine caller handoff, project-mode `up --json`, `artifacts export
--json`, and `down --json` accept `--lifecycle-invocation lci_<stable-id>`. Spawnfile
binds that id to the exact operation, correlation, and request policy, atomically stores
the exact JSON bytes after the owner returns and before stdout, and rejects reuse with
drift. `spawnfile lifecycle lookup <id>` is read-only and returns one versioned state:
`not_applied`, `pending`, `completed`, or `ambiguous`, without Docker/provider
inspection. Recovery only resumes an operation when that command verifies exact durable
evidence that resumption is safe; otherwise it seals `ambiguous` and fails closed.
It writes no secret values to output or diagnostics. The full verb list,
request/receipt contract, and exit behavior are in [`specs/TARGETS.md`](specs/TARGETS.md).
`target lookup_operation` accepts the original mutation request with a minimal
read-only context config and reports `completed`, `pending`, or `not_applied`
without calling the target provider or changing its journal.

Declare external credentials in `secrets:` and provide values through an ignored env file or the shell environment. `spawnfile auth sync --env-file .env` stores declared model auth and project secrets in a local auth profile; `spawnfile run --env-file .env` can inject the same values directly for a single run. This is the intended pattern for credentials like `GH_TOKEN`, MCP tokens, and provider API keys.

## Project structure

A Spawnfile project is either an `agent` or a `team`.

**Agent**

```text
my-agent/
├── Spawnfile
├── IDENTITY.md         # who the agent is
├── SOUL.md             # tone and personality
├── AGENTS.md           # system prompt
├── MEMORY.md           # long-lived memory
├── HEARTBEAT.md        # periodic prompt for scheduled wakes
├── skills/
│   └── web_search/SKILL.md
└── subagents/
    └── researcher/Spawnfile
```

**Team**

```text
my-team/
├── Spawnfile
├── TEAM.md
├── shared/skills/...
└── agents/
    ├── orchestrator/Spawnfile
    ├── researcher/Spawnfile
    └── writer/Spawnfile
```

Team members may target different runtimes; the compiler resolves each member independently. Subagents are internal helpers owned by a parent agent — not the same thing as team members. Team coordination is through shared declared agent surfaces and declared team networks, not a Spawnfile-owned router.

Not every file is required. Spawnfile names the portable roles; adapters decide how to lower them into runtime-native surfaces. See [`specs/SPEC.md`](specs/SPEC.md) for the full shape.

## Runtime support

v0.1 targets autonomous agent runtimes that share a markdown workspace identity model.

| Runtime   | Status        | Default | Surfaces                                      |
|-----------|---------------|---------|-----------------------------------------------|
| OpenClaw  | active        | ✅      | Discord, Telegram, WhatsApp, Slack            |
| PicoClaw  | active        |         | Discord, Telegram, Slack (WhatsApp blocked)   |
| Pi        | active        |         | Embedded org app, Moltnet client config       |
| OpenFang  | exploratory   |         | No active adapter yet                         |
| Hermes Agent | exploratory |        | No active adapter yet                         |
| OpenCode  | exploratory   |         | No active adapter yet                         |

Each adapter maps the portable schema into its native forms. The compiler reports a machine-readable `spawnfile-report.json` with the resolved graph, chosen runtimes, and capability outcomes (`supported`, `degraded`, `unsupported`). See [`specs/RUNTIMES.md`](specs/RUNTIMES.md) for the live matrix and pinned versions, or [`runtimes.yaml`](runtimes.yaml) for the registry source of truth.

## Why

Autonomous agent runtimes already share a meaningful core: markdown workspace identity, skill folders, MCP, model selection, sandboxing. Today that core is re-authored by hand for each runtime. Spawnfile makes it canonical so one source project can ship to any compatible runtime.

## Docs

Hosted docs with rendered specs, runtime guides, and a capability matrix: **[spawnfile.com](https://spawnfile.com)** — start at [Introduction](https://spawnfile.com/introduction/), [Quickstart](https://spawnfile.com/quickstart/), or the [Runtimes overview](https://spawnfile.com/runtimes/overview/).

The source-of-truth specs live in this repo:

- [`specs/INDEX.md`](specs/INDEX.md) — map of all specs
- [`specs/SPEC.md`](specs/SPEC.md) — canonical source format
- [`specs/COMPILER.md`](specs/COMPILER.md) — compiler architecture and adapter contract
- [`specs/CONTAINERS.md`](specs/CONTAINERS.md) — container compilation
- [`specs/RUNTIMES.md`](specs/RUNTIMES.md) — runtime registry and version pinning
- [`specs/SURFACES.md`](specs/SURFACES.md) — messaging surface model
- [`specs/STATUS.md`](specs/STATUS.md) — static and live operational status
- [`specs/DISTRIBUTION.md`](specs/DISTRIBUTION.md) — image distribution, publish, and sourceless run
- [`test/fixtures/`](test/fixtures/) — canonical example projects

## From source

```bash
git clone https://github.com/noopolis/spawnfile.git
cd spawnfile
nvm use
npm install
npm run build
npm link
```

For local development without linking globally:

```bash
npm run dev -- validate test/fixtures/single-agent
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, tests, and the runtime adapter contract.

## License

MIT — see [LICENSE](LICENSE).

---

**[spawnfile.com](https://spawnfile.com)** · **[github.com/noopolis/spawnfile](https://github.com/noopolis/spawnfile)**
