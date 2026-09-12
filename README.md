# Spawnfile

> Write your agent team once. Compile it for different runtimes.

<p align="center">
  <a href="https://www.npmjs.com/package/spawnfile"><img src="https://img.shields.io/npm/v/spawnfile?style=flat-square&color=d4604a&label=npm" alt="npm"></a>
  <a href="https://www.npmjs.com/package/spawnfile"><img src="https://img.shields.io/npm/dm/spawnfile?style=flat-square&color=d4604a" alt="downloads"></a>
  <a href="#try-it"><img src="https://img.shields.io/node/v/spawnfile?style=flat-square&color=d4604a" alt="node"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/spawnfile?style=flat-square&color=d4604a" alt="MIT"></a>
  <a href="https://spawnfile.com"><img src="https://img.shields.io/website?url=https%3A%2F%2Fspawnfile.com&style=flat-square&label=spawnfile.com&color=d4604a" alt="website"></a>
</p>

<p align="center">
  <img src="website/public/new-claw-images.png" alt="Spawnfile compiles one agent source into multiple runtimes" width="420" />
</p>

Describe your agents, give them identities and tools, and keep the whole team in one source project. Spawnfile compiles that project into the configuration and workspaces their runtimes need, then builds and deploys it with Docker.

```text
Spawnfile + workspace ─→ compile ─→ runtime files
```

## Try it

Start with one agent. Requires **Node.js 22.19+**; compilation needs no Docker or model credentials.

```bash
npm install -g spawnfile
spawnfile init my-agent
cd my-agent
spawnfile validate
spawnfile compile
```

`init` creates an OpenClaw project with `IDENTITY.md`, `SOUL.md`, and `AGENTS.md`. `compile` writes runtime configuration, the generated workspace, and container files into `.spawn/`. Read `spawnfile-report.json` there to see how your source was compiled. **The agent is configured, but has not started.**

Edit the Markdown files to define who the agent is and what it should do, then compile again. Keep the source in Git; `.spawn/` is generated and ignored.

## From one agent to a team

A team has its own `Spawnfile`, which references the member agent projects. Create its directory with `spawnfile init my-team --team`. Once you have two projects with distinct agent names under `my-team/agents/`, put their references in `my-team/Spawnfile`:

```yaml
spawnfile_version: "0.1"
kind: team
name: research-team
mode: swarm
members:
  - id: researcher
    ref: ./agents/researcher
  - id: writer
    ref: ./agents/writer
```

Each member has its own Spawnfile, identity, and runtime. Teams can share instructions and resources, contain nested teams, and declare [Moltnet](https://moltnet.dev) rooms. The [team guide](https://spawnfile.com/guides/teams/) covers the full setup; [examples](examples/) show complete projects.

## What travels with your team

- **Agents:** Identity documents, instructions, skills, workspace resources, and each agent’s wake schedule.
- **Tools and models:** MCP connections, model selection, and declared secret requirements.
- **Team structure:** Members, nested teams, and shared resources.
- **Communication:** Declared [Moltnet](https://moltnet.dev) networks and rooms for agents to exchange messages across runtimes.
- **Deployment:** Runtime configuration, container files, and a capability report built from the same source.

A team declaration alone does not create a conversation or a useful division of work. Give the agents a task, configure their communication, and choose how they wake. Start with the [team guide](https://spawnfile.com/guides/teams/) and [example projects](examples/).

## Run and share it

Once the prompts and configuration are ready:

1. **Provide credentials.** Import an existing subscription login or configure provider credentials with [auth profiles](https://spawnfile.com/guides/docker/). Keep secret values out of Git.
2. **Build and start.** With Docker available, `spawnfile up . --detach --auth-profile <profile>` compiles, builds, and starts the project. A Docker context can target another machine.
3. **Check the deployment.** `spawnfile status . --live` probes the running deployment; `spawnfile status .` reads only local declared and compiled state.
4. **Share an image.** `spawnfile publish` packages the project for an OCI registry so another operator can run it without the source, using their own credentials.

See [container deployment](specs/CONTAINERS.md), [status](specs/STATUS.md), and [image distribution](specs/DISTRIBUTION.md) for complete commands and requirements.

## Runtime support

| Runtime | Use it for |
|---|---|
| **Daimon** | Agents using subscription CLI engines such as Codex and Claude Code, with Moltnet and memory integration. |
| **OpenClaw** | OpenClaw agents and their native messaging surfaces. The default agent scaffold. |
| **PicoClaw** | PicoClaw agents and their native messaging surfaces. |

Daimon requires a pinned runtime image matching the compiler contract. The older `pi` adapter remains available for existing projects.

Portability is capability-specific: the compiler reports each feature as **supported**, **degraded**, or **unsupported**. Read that report before switching runtimes. Exact versions live in [runtimes.yaml](runtimes.yaml); the [runtime specification](specs/RUNTIMES.md) describes the adapter model.

## Go further

| I want to… | Read |
|---|---|
| Understand the source format | [Spawnfile specification](specs/SPEC.md) |
| Explore complete projects | [Examples](examples/) |
| Add an adapter or contribute | [Contributing](CONTRIBUTING.md) |
| Integrate with deployment tooling | [Target and lifecycle contracts](specs/TARGETS.md) |
| Find a detailed contract | [Specification index](specs/INDEX.md) |

Spawnfile is part of [Noopolis](https://github.com/noopolis). [Moltnet](https://moltnet.dev) supplies messaging; [Daimon](https://github.com/noopolis/daimon) runs individual agents; [Simfile](https://simfile.org) builds simulation worlds around organizations. You can use Spawnfile on its own.

## License

[MIT](LICENSE)

---

**[spawnfile.com](https://spawnfile.com)** · **[Examples](examples/)** · **[Contributing](CONTRIBUTING.md)**
