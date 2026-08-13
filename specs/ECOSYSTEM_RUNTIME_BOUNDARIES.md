# Ecosystem Runtime Boundaries

Status: normative and evolving.

This specification defines ownership and runtime boundaries between Spawnfile,
Simfile, Daimon, Moltnet, Mneme, Stele, and provider adapters. A local design
document, fixture, or vertical slice MUST NOT weaken these rules.

## 1. Non-Negotiable Invariant

**TL;DR:** Simfile runs the world, while agents run themselves. Starting the
services together does not give Simfile control over agent cognition.

The ecosystem separates four kinds of execution:

| Execution | Owner | Meaning |
|---|---|---|
| Organization compilation and lifecycle | Spawnfile | Resolve, package, configure, start, inspect, update, export, and stop agent organizations |
| World execution | Simfile | Advance world time and mechanics, derive perceptions, validate actions, record events, and evaluate probes |
| Agent execution | Daimon or another agent runtime | Wake, perceive, reason, use tools, remember, speak, and act independently |
| Provider transport | Moltnet or another provider | Authenticate, carry, order, page, stream, and export provider-native traffic |

Post-run causal verification is deliberately outside those live execution
planes. Simfile collects and verifies the declared artifact set, Stele parses
and reconciles the serialized authority events, and Simfile applies the
simulation's verdict policy to that result.

The word **orchestrate** MUST be qualified:

- **Lifecycle composition** may start and stop several services as one
  deployment.
- **World orchestration** may advance deterministic mechanics and process
  accepted inputs.
- **Agent orchestration** means selecting an agent, invoking its cognition,
  waiting for its answer, or alternating agents. Simfile MUST NOT do this.

The normative product command for a Simfile linked to a Spawnfile is:

```bash
simfile run ./Simfile --view
```

That command MAY perform lifecycle composition by delegating organization
operations to Spawnfile's public CLI and consuming versioned receipts. It MUST
start the world paused, prove world-only readiness, start and bind the
organization second, and release the clock only through authenticated topology
activation. No agent reply or action is part of that activation barrier or any
later tick. `simfile dev`, if introduced, is only a rebuild/watch/debug wrapper
over the same lifecycle; it MUST NOT own a second implementation.

World readiness uses the base `simfile.world-sidecar-runtime.v1` ABI and proves
a pristine `next_tick: 0` state. Optional, separately manifested capabilities
do not change that ABI; a live decision-claim path requires the exact
`simfile.world-decision-claim.v1` identity to be attested before activation.
The first-tick receipt MUST prove tick 1 followed activation without a
participant action. Organization readiness MUST bind a pinned
`spawnfile.moltnet-release-identity.v1`—architecture, asset digest, release
version, source revision, and the sole `pi-bridge` capability—rather than an
unpinned `latest` input.

`--lockstep`, if introduced, is restricted to an explicit local scripted
diagnostic and is ineligible for live-agent evidence. It MUST NOT make a
composed live world await agent cognition.

A world recommendation is local, optional, and non-blocking observation
metadata in the world event/projection stream. It is exposed only through an
ordinary granted sense after an agent wakes independently, and the agent may
ignore it. A recommendation MUST NOT use Moltnet, a direct or room message, a
mention, a principal-addressed delivery, a wake, or a nudge; it cannot select a
participant, create cognition, mint authority, or affect world timing.

## 2. Authority By Project

**TL;DR:** Every project owns one narrow authority and communicates through
versioned contracts. No project becomes a shortcut proxy for another project's
live behavior.

### 2.1 Spawnfile

**TL;DR:** Spawnfile builds and operates autonomous-agent organizations. It
does not carry their live conversations or simulation actions.

Spawnfile MAY:

- compile organization graphs, surfaces, schedules, resources, and provider
  attachment plans;
- generate configs, secret references, credentials, images, and deployment
  records;
- provision a managed provider service when declared;
- start, inspect, update, export, and stop deployments;
- report readiness and metadata-only diagnostics; and
- emit secret-free, versioned connection and topology plans for a composer.

Spawnfile MUST NOT:

- expose `send`, `read`, `subscribe`, `await`, or transcript operations for
  live provider traffic;
- proxy provider HTTP, WebSocket, SSE, stdio, or MCP operations;
- use `docker exec` as a public live-traffic API;
- decide when an agent thinks or acts;
- maintain a simulation action queue; or
- interpret world senses, actions, or physics.

### 2.2 Simfile

**TL;DR:** Simfile owns the world clock and the mechanical truth of the
simulation. It emits perceptions and accepts actions without deciding when or
how an agent thinks.

Simfile MAY:

- compose a complete simulation lifecycle by delegating organization and
  provider lifecycle operations to their owners;
- run clocks, variables, rules, dynamics, objects, spaces, probes, and ledgers;
- expose scoped senses and actions through configured adapters;
- publish world events as a normal provider participant;
- accept independently submitted actions into a deterministic ingress queue;
- process accepted actions according to the world's clock and ordering policy;
- record agentic inputs for replay; and
- export evidence and simulation state.

Simfile MUST NOT:

- call an agent to request its next move;
- wait for an agent decision before advancing the world clock;
- alternate, round-robin, or otherwise select which agent acts next;
- own an agent wake, cognition, prompt, memory, or reply loop;
- turn silence into a scripted fallback action;
- treat a hardcoded controller as live-agent evidence; or
- make provider transport semantics part of world mechanics.

An event-driven world MAY wait for a declared world event. It MUST NOT invent an
"agent turn" event that exists only to force cognition or serialize otherwise
autonomous agents.

### 2.3 Daimon And Other Agent Runtimes

**TL;DR:** Each agent runtime owns its agent's independent cognitive loop.
Agents decide when and how to respond using the perceptions and tools they are
allowed to access.

An agent runtime owns:

- wake handling and coalescing;
- prompt and context construction;
- model invocation and continuation;
- tool and MCP use;
- local session state;
- memory interaction through Mneme;
- response and world-action intent returned to its caller; and
- per-agent failure and turn telemetry.

Spawnfile may declare and compile schedules or wake policies, but the runtime
executes them. A Daimon `turn` is internal agent telemetry, never the unit by
which Simfile advances the world.

The surrounding Node/runtime or provider bridge may originate scheduled wakes,
deliver provider events, and publish Daimon's returned response through a
provider-owned client. That wrapper MUST preserve the authoritative Daimon
output event as a cause and MUST NOT move cognition into Spawnfile or Simfile.

### 2.4 Moltnet And Other Communication Providers

**TL;DR:** A communication provider owns its wire protocol and reusable live
client. Callers connect directly instead of asking Spawnfile to relay traffic.

Moltnet owns:

- authentication and participant identity;
- message and causal-envelope wire types;
- rooms, DMs, membership, and write policy;
- cursor pagination and subscriptions;
- idempotent send behavior;
- canonical transcript export; and
- its CLI, machine client, SDKs, and conformance tests.

Simfile may bind world events to Moltnet through a Moltnet-owned client.
Spawnfile may provision Moltnet and emit attachment material, but MUST NOT
reimplement or proxy the live client.

### 2.5 Mneme

**TL;DR:** Mneme owns durable memory mechanics and policy. Simfile may provide
perceptions and Daimon may use memory, but neither reimplements Mneme storage.

Mneme owns memory storage, scope enforcement, recall, redaction, forgetting,
and its MCP or direct client surfaces. Agent judgment about what to remember
remains agent behavior.

### 2.6 Stele

**TL;DR:** Stele independently checks the causal evidence emitted by the live
authorities after export. It is a pure verification library, not another
runtime service or source of world truth.

Stele owns:

- the `noopolis.causal-event.v1` read schema and parser;
- canonical event hashing;
- per-run causal-graph reconciliation;
- sequence-gap and declared-final-position checks;
- cycle, self-edge, cross-run-edge, duplicate, and divergence detection; and
- deterministic backward chain tracing.

Stele MUST remain read/verify only. It MUST NOT emit product events, perform
I/O, import product implementations, invent missing edges, stitch fixtures
into production evidence, or decide the final simulation verdict. Each live
authority owns its event emission; Simfile's observer owns artifact
collection, integrity policy, and the final `valid` / `invalid` /
`incomplete` mapping.

## 3. Autonomous Runtime Flow

**TL;DR:** The world and the agents run concurrently and communicate through
events, senses, and actions. There is no central observe-decide-act turn loop.

The required runtime shape is:

```text
                       lifecycle composition only
                 +-----------------------------------+
                 |   Simfile lifecycle composer      |
                 +-----------+------------+----------+
                             |            |
                    delegates lifecycle   |
                             |            |
                     +-------v------+  +--v----------------+
                     | Spawnfile org |  | Simfile world     |
                     | lifecycle     |  | clock + mechanics |
                     +-------+------+  +--+--------------+--+
                             |            |              ^
                             |       perceptions         | actions
                             |            |              |
                      +------v------------v--+       +---+-----------+
                      | provider surfaces   |       | action ingress |
                      | Moltnet / MCP / ... |       | validation     |
                      +------+--------------+       +---^-----------+
                             |                          |
                    +--------v--------------------------+--+
                    | autonomous Daimon/other agents       |
                    | independent wake, reason, tool loops |
                    +--------------------------------------+
```

After the live run:

```text
Spawnfile + Simfile + Moltnet + Daimon + Mneme exports
                            |
                            v
                  verified artifact manifest
                            |
                            v
                 Stele parse + reconciliation
                            |
                            v
                  Simfile observer verdict
```

Forbidden production shape:

```text
Simfile -> observe red -> await red -> step
        -> observe blue -> await blue -> step
        -> repeat
```

Allowed development shape:

```text
scripted test double -> same public action ingress -> deterministic world
```

The scripted double MUST live in test or fixture code, disclose its provenance,
and produce evidence labeled as non-live. Replacing the double with Daimon MUST
not require changing world mechanics or the public sense/action contracts.

## 4. Senses, Actions, And MCP

**TL;DR:** Simfile declares what can be perceived and changed; adapters decide
how those capabilities reach each agent. MCP is one configurable binding, not
the owner of the simulation or agent loop.

### 4.1 Addressed World Ports

**TL;DR:** Every perceivable or actionable capability has a stable address.
Objects may expose ports, but object identity is separate from the available
senses and actions.

A world interaction contract SHOULD use stable addresses such as:

```text
world://pitch/objects/ball
world://pitch/senses/vision
world://pitch/actions/kick
world://building/floors/4/lights/main
```

An object can be the target of several independently granted senses and
actions. An inner simulation may export selected ports to its parent without
exposing its entire internal state.

### 4.2 Sense Composition

**TL;DR:** A sense transforms authoritative world state into a scoped
perception. Different agents may receive different representations of the same
object.

Sense composition may include:

- scope filtering;
- spatial or temporal windows;
- projection and occlusion;
- typed representations such as RGBA components;
- derived scalar or vector sensations;
- embeddings or classifications;
- noise and bounded uncertainty; and
- push, pull, or subscription delivery.

The world owns the authoritative source state and records mechanically relevant
transform provenance. The agent owns interpretation of the resulting
perception.

### 4.3 Action Composition

**TL;DR:** An action is a validated request to change the world, not a command
to an agent. The world applies accepted actions through configured mechanics or
dynamics adapters.

Examples include:

```text
kick(object, direction, intensity)
move(direction, speed)
set(world://building/floors/4/lights/main, true)
```

Actions may be submitted at any time. Simfile assigns authoritative receipt,
ordering, simulation-time application, validation, and mechanical outcome;
agents choose whether and when to submit them.

### 4.4 MCP Binding

**TL;DR:** MCP can expose configured senses as resources/tools and actions as
tools. It does not create turns, choose agents, or require the world to wait.

A Simfile plan may generate an agent-scoped MCP binding that exposes only the
granted world ports. The same semantic ports may later bind to another
transport without changing world mechanics.

Push perception and wake delivery require a provider or runtime event path;
tool invocation alone MUST NOT be mistaken for autonomous wake scheduling.

## 5. Determinism Without Scripted Agents

**TL;DR:** The world is deterministic even though agents are not. Replay pins
the recorded agent action stream as input instead of rerunning agent decisions.

The world clock follows its declared real-time, fixed-step, discrete-event, or
manual policy. It does not slow down, stop, or reorder itself merely because an
agent is late or silent.

For concurrently arriving actions, Simfile MUST define canonical admission and
application ordering using host-authenticated identity, event IDs, simulation
time, and deterministic tie-break rules. Arrival and accepted action records
become replay inputs.

## 6. Enforcement Gates

**TL;DR:** Documentation states the boundary, but CI and acceptance tests keep
it from drifting. A boundary change is incomplete until all applicable gates
pass.

### Gate A: Normative Ownership

**TL;DR:** Every implementation area links to this specification from its
`AGENTS.md`. Reviewers can reject a misplaced feature before reading its
implementation details.

**Why:** File-local guidance is loaded while work is being done, which prevents
an attractive vertical-slice shortcut from silently becoming architecture.

Pass conditions:

- root and relevant nested `AGENTS.md` files name the owner of live behavior;
- new provider operations identify their owning project; and
- architecture documents use “lifecycle composition,” “world execution,” or
  “agent execution” instead of the unqualified word “orchestration.”

### Gate B: Static Dependency And Command Ratchets

**TL;DR:** CI rejects known boundary-crossing imports, commands, and protocol
implementations. Exceptions must be narrow, named diagnostics with no
behavioral feedback path.

**Why:** Architectural intent is otherwise easy to bypass with one convenient
helper or CLI command.

At minimum, automated checks MUST reject:

- public Spawnfile live-traffic commands such as provider `send`, `read`,
  `subscribe`, or transcript proxies;
- Spawnfile production code that implements provider message bodies, cursors,
  or conversation polling;
- Simfile world/runtime code that invokes Daimon control or model APIs;
- production Simfile interfaces named or shaped as `awaitDecision`,
  `runAgentTurn`, `nextAgent`, or equivalent serialized cognition; and
- production dependencies on scripted fixture controllers.

### Gate C: Autonomous Clock Acceptance

**TL;DR:** A live acceptance test proves the world advances while every agent
is silent. It also proves agents may submit actions independently and
concurrently.

**Why:** A turn orchestrator can look correct in happy-path transcripts while
quietly making simulation time depend on model latency.

Pass conditions:

- no agent reply is required for the next world step;
- zero, one, or many actions may be accepted in a clock interval;
- action order follows the declared deterministic policy, not an agent roster;
  and
- agent failure or silence is observed but does not fabricate an action.

### Gate D: Replaceable Test Doubles

**TL;DR:** Scripted agents use the exact production sense/action boundary and
are visibly non-live. Removing them does not change the world engine.

**Why:** Hardcoded controllers are useful for plumbing, but they become harmful
when their alternating loop defines the production architecture.

Pass conditions:

- test doubles live under tests, fixtures, or an explicitly named development
  adapter;
- their evidence declares scripted provenance and cannot satisfy live-agent
  acceptance;
- no production world module imports them; and
- a Daimon implementation can replace them through configuration.

### Gate E: Provider-Owned Client Conformance

**TL;DR:** Every live provider path uses a client owned and tested by that
provider. Spawnfile supplies attachment material but never relays the traffic.

**Why:** Duplicated clients drift on authentication, pagination, causal fields,
and transcript semantics.

Pass conditions:

- authentication, send, read/subscribe, cursor, idempotency, and export tests
  live with the provider client;
- Simfile tests only its semantic adapter and world bindings;
- Spawnfile tests only compilation, topology, secret references, lifecycle,
  readiness, and metadata diagnostics; and
- no provider token value appears in receipts, logs, or deployment records.

### Gate F: Shared Causal Verification

**TL;DR:** Exported authority events are parsed and reconciled through Stele,
then Simfile applies the run policy. A direct-parent lookup is not enough to
call an entire causal chain complete.

**Why:** A run can look successful when an ancestor is missing, belongs to
another run, sits behind a sequence gap, or participates in a cycle.

Pass conditions:

- reconciliation is scoped by `run_id` and rejects cross-run causes;
- self-causes and cycles are reported and can never be `complete`;
- incomplete, stale, unknown, or divergent ancestor state propagates to every
  dependent chain;
- sequence gaps and declared final stream positions participate in the result;
- malformed, undeclared, or missing sources cannot be silently skipped;
- production verification never stitches or synthesizes causal edges; and
- Simfile derives its verdict from the verified artifact set plus Stele's
  reconciliation result instead of reimplementing the graph rules.

## 7. Change Review Checklist

**TL;DR:** Every cross-project feature answers the same ownership questions
before code lands. If an answer names two authorities for one behavior, the
contract is not ready.

Before implementation:

1. Which project owns the semantic behavior?
2. Which project owns the live wire/client?
3. Is Simfile composing service lifecycle or controlling an agent?
4. Can the world advance with all agents silent?
5. Can a real autonomous agent replace the test double without engine changes?
6. Are senses and actions independently addressable and configurable?
7. Does the proposed MCP surface preserve, rather than own, those semantics?
8. Does exported causal evidence reconcile through Stele without stitching?
9. What static and live tests prevent this boundary from regressing?
