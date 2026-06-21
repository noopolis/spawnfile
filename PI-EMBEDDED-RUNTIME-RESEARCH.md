# Pi Embedded Runtime Research

Status: research note, not an implementation spec.

Date: 2026-06-20

Pi source inspected:

- Repository: `https://github.com/earendil-works/pi.git`
- Local clone: `/tmp/spawnfile-pi-research.byREkj/pi`
- Commit: `8b97e75c6b149fdd4dec95fe3321d1e94fd5c1d4`
- Package versions inspected: `@earendil-works/pi-agent-core@0.79.8`,
  `@earendil-works/pi-coding-agent@0.79.8`,
  `@earendil-works/pi-ai@0.79.8`
- Node requirement: `>=22.19.0`

## Question

Can Spawnfile compile a full agentic organization into one application process
that hosts all agents, instead of always starting external runtime gateways such
as PicoClaw or OpenClaw?

More specifically: can Pi be the harness under `spawnfile up` for real coding
agents like the Jiang Lens organization, where agents edit files, run commands,
use skills, maintain durable state, wake on schedules, and communicate through
Moltnet?

## Short Answer

Yes, Pi is a credible candidate for a Spawnfile-managed embedded runtime.

The strongest path is not to shell out to `pi` as another CLI. The stronger path
is to run a Spawnfile supervisor process that creates one Pi agent session or
harness per Spawnfile agent.

```text
spawnfile up
  -> starts container or local supervisor
      -> managed Moltnet server, when declared
      -> scheduler
      -> Moltnet delivery router
      -> status and lifecycle collector
      -> Pi session: socrates
      -> Pi session: virgil
      -> Pi session: plato
      -> Pi session: dante
      -> Pi session: aristotle
      -> Pi session: cassandra
```

This keeps orchestration in Spawnfile and uses Pi only as the per-agent turn
engine.

The recommended first implementation shape is internal to Spawnfile, with a
clean driver boundary that can later be extracted if a second embedded harness
proves the same interface.

## Current Spawnfile Runtime Model

Spawnfile currently treats runtimes as container-oriented gateway targets.

Current adapter contract in `src/runtime/types.ts` includes:

- `compileAgent`
- runtime-owned generated files
- container metadata
- start command
- instance paths
- config env bindings
- auth preparation
- status probes

The current active adapters are:

- `openclaw`
- `picoclaw`

Each adapter emits runtime config and files under a runtime-specific workspace.
The generated container entrypoint starts:

- managed Moltnet servers
- one process per runtime target
- one `moltnet node` bridge per Moltnet attachment

This model works for external runtimes, but it is not ideal for a "full org in
one app" mode because it creates separate gateway processes and bridge processes
where an embedded supervisor could route wakes directly in memory.

## Real-World Requirements From Jiang Lens

The Jiang Lens `agentic-org` is the useful stress test. It currently declares:

- one managed Moltnet network
- public read-only rooms with member-only writes
- six PicoClaw agents
- per-agent schedules
- per-agent durable state volumes
- shared mutable public Git repo
- shared readonly private Git repo
- shared skills outside the org directory
- global packages such as `gh`, `yt-dlp`, `node`, `npm`, and `@openai/codex`
- required project secrets
- Codex model auth
- explicit Moltnet wake policy per room

Representative root requirements from
`/Users/apresmoi/Documents/jiang-lens/agentic-org/Spawnfile`:

```yaml
shared:
  workspace:
    resources:
      - kind: git
        mount: ./repos/jiang-lens
        mode: mutable
      - kind: git
        mount: ./repos/jianglens-private
        mode: readonly
    skills:
      - ref: ../.codex/skills/moltnet
      - ref: ../.codex/skills/jiang-video-e2e
  environment:
    secrets:
      - name: GITHUB_APP_ID
      - name: GITHUB_APP_PRIVATE_KEY_B64
      - name: MOLTNET_AGENT_TOKEN
      - name: MOLTNET_OPERATOR_TOKEN
    packages:
      - manager: apt
        name: gh
      - manager: pipx
        name: yt-dlp
      - manager: npm
        name: "@openai/codex"
```

Representative agent requirements:

```yaml
runtime:
  name: picoclaw
  options:
    restrict_to_workspace: true

execution:
  model:
    primary:
      provider: openai
      name: gpt-5.5
      auth:
        method: codex
  sandbox:
    mode: workspace

schedule:
  kind: cron
  cron: "8,38 * * * *"
  timezone: UTC
  prompt: "Wake as Aristotle..."

surfaces:
  moltnet:
    - network: local_lab
      rooms:
        episode-floor:
          wake: mentions

workspace:
  docs:
    identity: IDENTITY.md
    soul: SOUL.md
    system: AGENTS.md
    memory: MEMORY.md
    heartbeat: HEARTBEAT.md
    extras:
      setup: SETUP.md
      state: STATE.md
  resources:
    - id: aristotle-state
      kind: volume
      mount: ./state
      mode: mutable
```

Jiang Lens also documents an important behavioral rule:

- scheduled wakes do not automatically publish to Moltnet
- a visible scheduled turn must explicitly call `moltnet send`
- `wake: mentions` means Moltnet calls the agent's attention, not "auto-reply"
- long-running production work happens inside `./repos/jiang-lens`
- generated runtime docs are context, not the main project repo

Pi support must preserve these semantics.

## Pi Capabilities Relevant To Spawnfile

### Package Layout

Pi has three relevant packages:

- `@earendil-works/pi-agent-core`: lower-level agent runtime, tool calling,
  state management, event streaming, harness APIs.
- `@earendil-works/pi-coding-agent`: CLI plus SDK, sessions, resource loading,
  default coding tools, skills, extensions, model registry, auth storage.
- `@earendil-works/pi-ai`: provider abstraction and model streaming.

### Embedding

Pi explicitly supports embedding through its SDK:

- `createAgentSession`
- `createAgentSessionRuntime`
- `AgentSession`
- `SessionManager`
- `AuthStorage`
- `ModelRegistry`
- `DefaultResourceLoader`

The SDK supports direct in-process usage. RPC mode also exists, but Pi's own
docs say Node/TypeScript applications should prefer the SDK over spawning RPC.

### Lower-Level Harness

`AgentHarness` in `packages/agent/src/harness/agent-harness.ts` is the cleanest
primitive for a Spawnfile-native supervisor.

It provides:

- `prompt`
- `skill`
- `promptFromTemplate`
- `steer`
- `followUp`
- `nextTurn`
- `appendMessage`
- `compact`
- `waitForIdle`
- `abort`
- event subscription
- model updates
- tool updates
- resource updates
- explicit `ExecutionEnv`
- explicit `Session`

Important queue behavior:

- `prompt` only runs when idle.
- `steer` and `followUp` are valid only while active.
- `nextTurn` can queue a message even while idle, and queued messages are
  prepended into the next prompt.

This maps well to Moltnet wake accumulation. If an agent is busy, Spawnfile can
append wake context into `nextTurn` and trigger another turn after idle.

### Coding Tools

`@earendil-works/pi-coding-agent` includes coding tools:

- `read`
- `bash`
- `edit`
- `write`
- `grep`
- `find`
- `ls`

It also exports tool factories such as:

- `createCodingTools`
- `createReadOnlyTools`
- `createBashTool`
- `createEditTool`
- `createWriteTool`
- `withFileMutationQueue`

So Pi can cover the basic coding-agent surface needed by Jiang Lens: read files,
edit files, write files, run shell commands, search, and inspect directories.

### Filesystem And Command Execution

The lower-level harness has an `ExecutionEnv` interface that combines:

- filesystem operations
- shell execution

The Node implementation runs commands through bash or sh in a configured cwd.

This is enough to run:

- `git`
- `gh`
- `node`
- `npm`
- `yt-dlp`
- project scripts
- `moltnet`

Spawnfile must still install these packages in the generated environment.

### Resources, Skills, And Context

The SDK `DefaultResourceLoader` can load:

- extensions
- skills
- prompt templates
- themes
- context files
- system prompt files
- append system prompt files

It also accepts overrides:

- `additionalSkillPaths`
- `additionalExtensionPaths`
- `additionalPromptTemplatePaths`
- `systemPrompt`
- `appendSystemPrompt`
- `skillsOverride`
- `agentsFilesOverride`
- `systemPromptOverride`
- `appendSystemPromptOverride`

This gives Spawnfile two options:

1. Write generated files into a Pi-compatible workspace and let Pi discover
   them.
2. Provide an explicit resource loader so Pi sees exactly the Spawnfile-compiled
   skills/docs/prompts.

For unattended orgs, the explicit loader is safer and more deterministic.

### Sessions And Memory

Pi sessions are JSONL trees with:

- messages
- model changes
- thinking-level changes
- active-tool changes
- compactions
- branch summaries
- custom entries
- custom messages
- labels

The SDK supports:

- `SessionManager.create(cwd, sessionDir)`
- `SessionManager.continueRecent(cwd, sessionDir)`
- `SessionManager.inMemory(cwd)`
- `SessionManager.open(path)`
- `SessionManager.forkFrom(...)`

By default, session storage is derived from cwd under `~/.pi/agent/sessions`,
but Spawnfile can pass explicit per-agent session directories. That is required
for correctness.

### Auth

Pi's `AuthStorage` stores credentials in `auth.json` and uses file locks during
OAuth refresh. This is materially better than mounting a whole shared CLI home
into multiple agents.

Pi supports:

- API keys
- OAuth credentials
- environment fallback
- custom provider config
- OpenAI Codex OAuth provider through `openai-codex`
- Anthropic OAuth provider

Important caveat:

Jiang Lens currently uses Spawnfile model auth method `codex`, meaning the
current runtime path imports Codex CLI credentials. Pi's `openai-codex` provider
uses Pi's own auth format in `~/.pi/agent/auth.json`, not necessarily Codex
CLI's `~/.codex` state. A Pi adapter must define how Spawnfile maps
`auth.method: codex`.

Reasonable options:

- first pass: support `api_key` only for Pi
- second pass: add Pi auth-profile import for `openai-codex`
- later: translate or broker Codex CLI auth into Pi `AuthStorage` if feasible

### Provider Support

Pi AI includes providers for:

- OpenAI Responses
- OpenAI Codex Responses
- Anthropic
- Google
- Google Vertex
- Mistral
- Amazon Bedrock
- Azure OpenAI
- OpenAI-compatible completions
- GitHub Copilot related flows
- custom providers through `models.json`

This is broad enough for Spawnfile's current model provider needs, but the
Spawnfile model-auth matrix must be mapped carefully.

### Extensions

Pi extensions can register tools, subscribe to events, intercept tool calls,
persist session state, and add commands.

This is powerful but should not be exposed by default for unattended Spawnfile
deployments. Extensions are TypeScript modules with full process permissions.

Recommended policy:

- Spawnfile-generated Pi runtime disables project-local extension discovery by
  default.
- Spawnfile can allow explicit extension refs later.
- Spawnfile-owned tools should be injected as SDK custom tools, not by allowing
  arbitrary `.pi/extensions`.

### Security Boundary

Pi is explicit that it is not a sandbox. It runs with the permissions of the
process that launches it.

For Spawnfile, that means:

- Docker or another OS/container boundary remains the actual sandbox.
- `execution.sandbox.mode: workspace` must be enforced by Spawnfile path layout,
  tool options, or container mounts.
- Pi should not be treated as a permission boundary.

## Fit Matrix

| Requirement | Pi support | Notes |
| --- | --- | --- |
| Multiple agents in one process | Yes | One `AgentHarness` or `AgentSession` per agent. |
| Isolated agent sessions | Yes | Use explicit per-agent session dirs. |
| Isolated agent workspaces | Yes | Use per-agent cwd/workspace paths. |
| File read/write/edit | Yes | Coding-agent SDK exports tools. |
| Shell commands | Yes | `bash` tool and `NodeExecutionEnv.exec`. |
| Git repo work | Yes | Requires `git` installed and resources cloned/mounted by Spawnfile. |
| Shared mutable repo resource | Mostly | Works if Spawnfile mounts/symlinks the same checkout; needs concurrency policy. |
| Readonly repo resource | Yes | Enforce via mount permissions/container, not Pi itself. |
| Volume resources | Yes | Spawnfile mounts volumes into each agent cwd. |
| Skills | Yes | Use explicit resource loader or generated `.agents/skills`. |
| Context docs | Yes | Generate system prompt and/or context files. |
| Cron schedules | Not built in at org level | Spawnfile supervisor should own scheduling. |
| Moltnet wake | Yes, by integration | Supervisor should subscribe to Moltnet and call `prompt`/`nextTurn`. |
| Moltnet send/read | Yes | Provide CLI in path or custom tools. |
| Status events | Yes | Map Pi events to Spawnfile status. |
| Tool event audit | Yes | `tool_call`, `tool_result`, provider events, queue events. |
| Codex auth | Needs design | Pi supports OpenAI Codex OAuth, but not necessarily Codex CLI home import. |
| Claude Code session reuse | Avoided | Pi uses provider APIs/OAuth directly, not spawning Claude Code CLI. |
| MCP | Not native as inspected | Could be custom tools or extension, but not equivalent today. |
| Subagents | Not native as a fixed feature | Can spawn multiple harnesses; Spawnfile should own org graph. |
| Permission prompts | No | Good for automation, but Spawnfile must own policy. |

## Proposed Spawnfile Architecture

### Internal Runtime Names

Add an experimental runtime:

```yaml
runtime:
  name: pi
  options:
    mode: harness
```

Avoid exposing too many Pi-specific options at first.

### Supervisor Ownership

Spawnfile should own:

- org graph
- deployment topology
- workspace/resource materialization
- package installation
- model/auth resolution
- Moltnet server startup
- Moltnet room membership
- wake routing
- schedule routing
- lifecycle event persistence
- status output
- concurrency limits
- shutdown/restart behavior

Pi should own:

- one agent turn
- model stream
- tool loop
- session tree
- compaction
- tool execution hooks
- per-agent queue primitives

### Driver Boundary

Keep the Pi integration internal but shaped like a driver:

```ts
interface EmbeddedAgentDriver {
  startAgent(spec: EmbeddedAgentSpec): Promise<EmbeddedAgentHandle>;
}

interface EmbeddedAgentHandle {
  id: string;
  wake(input: WakeInput): Promise<void>;
  enqueue(input: WakeInput): Promise<void>;
  status(): EmbeddedAgentStatus;
  stop(): Promise<void>;
}
```

Do not make a public adapter library yet. The interface should be proven with
Pi first, then challenged with a second harness later.

### Wake Routing

Moltnet and schedules should route through the supervisor:

```text
Moltnet message accepted
  -> detect wake policy match
  -> if agent idle:
       prompt(agent, wake prompt with recent context)
     else:
       nextTurn(agent, accumulated wake context)
       mark wake.queued
  -> when agent settles:
       if nextTurn has messages:
         prompt(agent, queued wake drain prompt)
```

This avoids the CLI session-lock class of failures seen with Claude Code.

### Schedule Routing

For Pi mode, Spawnfile should lower `schedule` into the supervisor, not into Pi.

```text
cron fires
  -> wake agent with schedule prompt
  -> if busy, queue for next turn or coalesce according to policy
```

This gives consistent behavior across embedded agents and avoids requiring Pi to
grow an org scheduler.

### Moltnet Read/Send

There are two viable options:

1. Install the `moltnet` CLI and keep using the existing skill instructions.
2. Add Spawnfile-provided Pi custom tools:
   - `moltnet_read`
   - `moltnet_send`
   - `moltnet_participants`

First pass should keep the CLI available for compatibility with existing skills.
Second pass can add custom tools for better auth handling and structured audit.

### Workspace Layout

Each Pi agent should get:

```text
/var/lib/spawnfile/embedded/pi/<agent-id>/
  agent/
    auth.json or auth link/copy
    models.json
    settings.json
    sessions/
  workspace/
    AGENTS.md
    IDENTITY.md
    SOUL.md
    MEMORY.md
    HEARTBEAT.md
    skills/
    repos/
    state/
```

The supervisor should pass:

- `cwd = workspace`
- `agentDir = agent`
- explicit `sessionDir = agent/sessions`

This prevents the shared-home bug class where multiple agents mutate one CLI
home.

### Resource Mapping

Spawnfile resources remain Spawnfile resources:

- git resources are cloned/materialized before Pi starts
- volume resources are mounted or symlinked into the workspace
- shared resources may be physically shared but agent paths should be stable
- readonly resources must be enforced by filesystem/container permissions

Pi should not clone project repos itself.

### Skills And Docs

The simplest compatibility path:

- emit docs exactly as current adapters do
- emit skills under `workspace/skills`
- inject a Pi resource loader that loads only the generated skills
- build system prompt from Spawnfile docs and team context

Avoid relying on project auto-discovery for unattended deployments.

### Tool Policy

Initial Pi mode should support:

```yaml
runtime:
  name: pi
  options:
    tools:
      mode: coding
```

Where `coding` maps to Pi's read/bash/edit/write tool set.

Later:

```yaml
runtime:
  name: pi
  options:
    tools:
      allow:
        - read
        - bash
        - edit
        - write
        - moltnet_read
        - moltnet_send
```

But this should not be the first design surface unless needed.

## Scaling Assessment

### What Should Scale

A single supervisor can host many idle agents cheaply. Active agent turns are
mostly model-provider I/O, so concurrent turns are plausible.

Good fit:

- 2 to 20 agents in one local/dev deployment
- scheduled orgs with sparse wakes
- one managed Moltnet server plus embedded agents
- one container on a small VM

### What Needs Guardrails

Spawnfile needs supervisor-level controls:

- max active agents
- max turns per agent
- provider concurrency
- queue depth
- wake coalescing
- schedule skip/coalesce policy
- per-tool timeout
- process shutdown timeout
- memory/session compaction policy

Without these, a room flood or schedule collision can start too many model turns
or shell commands.

### What Does Not Scale In One Process

Avoid one-process deployment for:

- hundreds of active agents
- CPU-heavy local tool work
- untrusted project code
- agents requiring different OS-level permissions
- strong isolation between tenants

For those, the same embedded supervisor can be sharded into multiple containers
or machines later.

## Customization Options

Pi gives more customization points than Spawnfile should expose initially.

Useful immediately:

- model
- thinking level
- tool allowlist
- custom tools
- resource loader
- session dir
- auth storage
- stream options
- event subscriptions

Defer:

- arbitrary Pi extensions
- Pi themes/UI
- project-local Pi package loading
- exposed Pi RPC
- session tree navigation commands
- branch/fork UX

Spawnfile should expose portable semantics first and only leak Pi-specific
knobs when a real org needs them.

## Open Questions

### 1. Should Pi mode use `AgentHarness` or `createAgentSession`?

`AgentHarness` is cleaner for a Spawnfile-owned runtime:

- explicit execution environment
- explicit resources
- explicit tools
- simple event surface
- less Pi CLI behavior

`createAgentSession` is faster for compatibility:

- built-in coding tools
- built-in resource loader
- built-in model registry
- built-in auth storage
- closer to the Pi CLI behavior

Recommendation:

- prototype with `createAgentSession`
- design the final driver around the lower-level `AgentHarness`
- import Pi's coding tools rather than reimplementing them

### 2. How should `auth.method: codex` map?

PicoClaw/OpenClaw currently support Codex auth by importing Codex CLI material.
Pi supports OpenAI Codex OAuth through its own provider and `auth.json`.

Options:

- mark Pi `codex` auth unsupported in v1 and require API keys
- add `spawnfile auth sync --runtime pi` to create Pi `auth.json`
- translate Codex auth into Pi's auth format
- use Pi's own login flow separately

Recommendation:

- first implementation: `api_key` only, unless a quick spike proves Codex auth
  translation is safe
- near-term follow-up: support `openai-codex` auth profiles natively

### 3. Do we keep Moltnet bridge processes?

For Pi embedded mode, the target design should avoid separate bridge processes.
The supervisor can subscribe to Moltnet and
call Pi sessions directly.

That means Pi mode needs a Moltnet client library or internal subprocess. If no
Go client library exists, the first pass can run `moltnet node` bridge, but that
gives up much of the embedded advantage.

Recommendation:

- first spike can use CLI for send/read
- production Pi mode should route Moltnet wakes inside the supervisor

### 4. How do shared mutable repos behave?

Jiang Lens currently gives each agent its own repo checkout at the same relative
path. That avoids file mutation races at the cost of duplicate disk usage.

Pi mode can keep the same behavior.

Do not collapse all agents into one shared checkout by default. That would be a
semantic change and would make simultaneous edits harder to reason about.

### 5. Is Pi an active dependency risk?

Pi is moving quickly. The inspected commit has package version `0.79.8`, a high
iteration cadence, and a Node floor of `>=22.19.0`.

Spawnfile should pin exact Pi package versions in `runtimes.yaml` and in the
generated image, just like it does for PicoClaw and OpenClaw.

## Implementation Spike

Before adding a full adapter, build one focused spike.

### Spike Goal

Prove that Spawnfile can run two Pi agents in one supervisor process and route
wakes between them.

### Fixture

Add a fixture similar to:

```text
fixtures/e2e/pi-embedded-org/
  Spawnfile
  agents/
    alpha/
      Spawnfile
      AGENTS.md
    beta/
      Spawnfile
      AGENTS.md
```

Use a small local/faux model for unit tests and real provider auth only for live
e2e.

### Test Behavior

1. Compile the org.
2. Materialize two separate workspaces.
3. Start one supervisor.
4. Create two Pi sessions in-process.
5. Give both agents read/bash/edit/write tools.
6. Trigger Alpha.
7. Alpha writes a file in its workspace and sends or emits a message mentioning
   Beta.
8. Supervisor queues and wakes Beta.
9. Beta reads its own workspace and replies.
10. While Beta is busy, enqueue two more wake messages.
11. Confirm they accumulate and drain in one later turn.
12. Confirm status reports:
    - agent up
    - current phase
    - queue size
    - last wake
    - last error
    - last tool call

### Compatibility Test Against Jiang Lens Shape

Add a compile-only or dry-run fixture with:

- shared mutable git resource
- shared readonly git resource
- per-agent volume resource
- schedules
- Moltnet managed server
- bearer auth with public read
- required packages
- required project secrets
- skills from paths outside the org root

This test should assert generated paths and runtime plan shape. It should not
need real Jiang Lens content.

## Proposed Spawnfile Surface

Minimal first surface:

```yaml
runtime:
  name: pi
  options:
    mode: embedded
```

Optional future surface:

```yaml
runtime:
  name: pi
  options:
    mode: embedded
    session:
      persistence: durable
    tools:
      profile: coding
    extensions:
      mode: disabled
    concurrency:
      max_active_turns: 1
```

Avoid exposing raw Pi extension paths or Pi settings until there is a real need.

## Recommendation

Do not create a separate public adapter library yet.

Start inside Spawnfile with:

```text
src/runtime/pi/
src/embedded/
```

Keep the code shaped so it can be extracted later:

- `src/runtime/pi` handles compile-time lowering.
- `src/embedded` owns runtime supervisor contracts.
- `src/embedded/pi` binds those contracts to Pi.

The first useful milestone is not a perfect Pi adapter. It is a working
`spawnfile up` path that proves:

- multiple agents in one process
- isolated workspaces and sessions
- file mutation works
- command execution works
- skills are loaded
- Moltnet wake accumulation works
- schedules wake agents
- status reflects live state

If that works, Pi can become Spawnfile's first embedded runtime. If it does not,
the driver boundary still gives us a reusable shape for another harness.
