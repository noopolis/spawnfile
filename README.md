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
spawnfile validate                               # check the graph
spawnfile view .                                 # read-only graph view; writes no files
spawnfile compile                                # lower to runtime-native output
spawnfile status .                               # read declared/compiled status
spawnfile auth sync --profile dev --env-file .env
spawnfile build  --tag my-agent                  # compile + docker build
spawnfile up . --context gpu-4090 --detach       # build and run on a Docker context
spawnfile dev up . --auth-profile dev            # detached dev loop in .spawn-dev
spawnfile dev apply . --agent researcher         # hot-add/reload one Pi agent
spawnfile dev activity . --agent researcher      # inspect buffered Pi activity events
spawnfile run    --tag my-agent --auth-profile dev --detach
spawnfile status . --live                        # inspect the detached deployment
spawnfile publish . --tag you/my-agent:1.0.0     # compile + build + verify + push
```

Compiled output lands under `.spawn/` by default, including a `Dockerfile`, `entrypoint.sh`, `.env.example`, and a prebuilt `container/rootfs/` tree. `spawnfile build` uses the pinned runtime artifacts from `runtimes.yaml`; it does not rebuild runtimes from source. Daimon, OpenClaw, and PicoClaw use published copyable artifact images by default, so normal prompt/config edits reuse their dependency layers. To test a local runtime artifact instead, set `SPAWNFILE_DAIMON_RUNTIME_IMAGE`, `SPAWNFILE_OPENCLAW_RUNTIME_IMAGE`, or `SPAWNFILE_PICOCLAW_RUNTIME_IMAGE` to a local image tag. For Pi-heavy orgs, build a reusable runtime base with `npm run runtime:pi-base -- noopolis/spawnfile-pi-runtime:0.79.9-node24`, then set `SPAWNFILE_PI_RUNTIME_BASE_IMAGE` during `spawnfile up`. For `build`/`up` on a docker `--context`, Moltnet release assets are staged for that context's architecture (`amd64` or `arm64`); for local-only manual compile targeting a fixed architecture, set `SPAWNFILE_MOLTNET_TARGET_ARCH=amd64|arm64`.

`spawnfile status` is read-only. By default it shows authored and compiled state without Docker, runtime, or Moltnet calls. With `--live`, it reads the selected detached deployment record, inspects the recorded Docker target, runs adapter-owned runtime probes, and checks Moltnet metadata without reading message bodies. Add `--logs` for a redacted Docker log tail, or `--watch` to refresh status continuously. For a remote Docker context where the local record is missing, pass `--context <name>` with `--live` to recover the deployment from Spawnfile container labels.

`spawnfile dev` is the source-backed interactive loop. It uses `.spawn-dev/` by default, starts a detached dev deployment with `spawnfile dev up`, and can hot-apply one Daimon runtime agent with `spawnfile dev apply --agent <id>` without restarting the rest of the org. Hot apply recompiles source, copies the selected agent workspace, Daimon config, matching Moltnet node configs, and managed Moltnet server configs into the running container, loads it through the Daimon control endpoint, and starts only that agent's Moltnet bridges when it is new. `spawnfile dev activity` reads the generated Daimon app's bounded activity buffer as JSON lines so operators can see queued wakes, turn starts/completions, runtime event types, output completions, and errors without mixing those diagnostics into Moltnet chat. Running managed Moltnet servers keep their current in-memory room membership until an operator-token `moltnet apply` or server restart reconciles the copied server config.

Compiled images are self-describing: `spawnfile publish` pushes one to any OCI registry, and anyone can run it with no source — `spawnfile up you/my-agent:1.0.0 --deployment prod --detach --auth-profile me` — or inspect what it needs first with `spawnfile status you/my-agent:1.0.0`. See [`specs/DISTRIBUTION.md`](specs/DISTRIBUTION.md).

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
| NullClaw  | exploratory   |         | No active adapter yet                         |
| ZeroClaw  | exploratory   |         | No active adapter yet                         |
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
- [`fixtures/`](fixtures/) — canonical example projects

## From source

```bash
git clone https://github.com/noopolis/spawnfile.git
cd spawnfile
nvm use
npm install
npm run build
npm link
```

To clone pinned runtimes and generate reference blueprints:

```bash
npm run runtimes:sync
```

For local development without linking globally:

```bash
npm run dev -- validate fixtures/single-agent
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, tests, and the runtime adapter contract.

## License

MIT — see [LICENSE](LICENSE).

---

**[spawnfile.com](https://spawnfile.com)** · **[github.com/noopolis/spawnfile](https://github.com/noopolis/spawnfile)**
