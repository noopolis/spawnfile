# Direct Surfaces Research

Status: working note  
Date: 2026-03-28

This note defines the shape of the direct protocol surfaces that Spawnfile agents should eventually expose on their own:

- `http`
- `webhook`
- `a2a`

It also defines the compatibility constraints that should keep those surfaces extensible enough for future shared-network surfaces.

This is not a normative spec yet. It is a design note to prevent the direct-surface work from drifting into runtime-specific or network-specific shapes too early.

## Why This Exists

Spawnfile needs two different communication categories:

1. direct surfaces, where an external client or agent talks to one agent directly
2. future shared-network surfaces, where agents and humans participate in a common communication space

Those are different jobs.

The direct surfaces are:

- `http`
- `webhook`
- `a2a`

That split should stay explicit:

```text
+-------------------+       +------------------------+
| direct surfaces   |       | future network surface |
| http / webhook    |       | separate topology      |
| a2a               |       | rooms / DMs / streams  |
+-------------------+       +------------------------+
```

## Core Rule

Direct surfaces must work on their own.

A user should be able to deploy agents with Spawnfile and expose them only through:

- `http`
- `webhook`
- `a2a`

without running any shared network.

That should feel like:

```text
+----------+      +----------------+      +------------------+
| client   | ---> | direct surface | ---> | spawnfile agent  |
| or agent |      | http/a2a/etc   |      | runtime-backed   |
+----------+      +----------------+      +------------------+
```

Any future shared-network surface is additional, not the default transport under all other surfaces.

Another hard rule:

- direct surfaces belong to agents
- teams are coordination topology, not direct protocol endpoints

So in Spawnfile terms:

```text
agent
  -> may expose direct protocol surfaces
  -> may expose platform messaging surfaces
  -> may expose future network surfaces

team
  -> groups agents
  -> coordinates them
  -> does not itself expose a direct endpoint
```

Here, `platform messaging surfaces` means concrete surfaces like:

- `discord`
- `telegram`
- `slack`
- `whatsapp`

It is a category label, not a manifest surface name.

## Compatibility Goal

The right compatibility target is not:

- "all surfaces use the same endpoints"

The right target is:

- "all surfaces can preserve the same envelope semantics"

That means the protocol family should share:

- identity concepts
- message part concepts
- task concepts
- artifact and file concepts
- event and streaming concepts

while still allowing different direct topologies:

- direct request/response
- webhook push
- A2A task exchange

Shared-network topology is intentionally out of scope for this note.

## Three Layers

The cleanest way to reason about this is with three layers.

```text
+-----------------------------------------------------------+
| topology layer                                            |
| direct call | webhook push | a2a exchange                 |
+-----------------------------------------------------------+
| envelope layer                                            |
| identities | message parts | tasks | artifacts | events   |
+-----------------------------------------------------------+
| transport layer                                           |
| HTTP | SSE | WebSocket | webhook delivery | A2A binding   |
+-----------------------------------------------------------+
```

If we keep those layers separate:

- direct surfaces can stay simple
- A2A can stay task-centric while still mapping cleanly to shared parts and artifacts
- a future shared-network surface can add room semantics without redefining message semantics

## Direct Surface Roles

### HTTP

`http` should mean:

- a direct agent-facing synchronous or semi-asynchronous API
- easy local and server-to-server invocation
- good fit for automation and internal systems

It is the simplest surface to test and the simplest surface to bridge.

### Webhook

`webhook` should mean:

- agent events or replies pushed to caller-owned endpoints
- good for external integrations
- good for async callback flows

This is not the same as `http`, even if both use HTTP transport.

`http` is generally caller-pulls or caller-initiates.  
`webhook` is agent-push or callback delivery.

### A2A

`a2a` should mean:

- direct agent-to-agent communication
- task-oriented exchange
- streaming progress and artifacts
- interoperable external exposure

Inside Spawnfile, `a2a` should be a first-class direct surface:

```text
+---------+   a2a    +------------------+
| agent A | <------> | spawnfile agent  |
+---------+          +------------------+
```

Any future network-level A2A bridge is outside the scope of this note.

The dedicated `a2a` surface should support the full A2A protocol shape, including:

- Agent Card discovery
- A2A task and message operations
- A2A streaming
- A2A artifact delivery

Plain `http` does not need to expose all of that. It only needs to be expressive enough that a full A2A surface can be implemented on top of the same internal envelope family without losing information.

## Shared Envelope Family

To stay compatible across `http`, `webhook`, and `a2a`, while remaining extensible for future network surfaces, the envelope family should be shared.

The envelope should be able to represent:

- who sent the message
- who the target is
- what the content is
- whether it belongs to a task
- whether it carries files or other artifacts
- whether more updates are coming

Conceptually:

```text
message
  -> from
  -> to
  -> context
  -> parts[]
  -> task?
  -> artifacts?
  -> metadata
```

### Identity

Shared identity fields should be able to represent:

- human
- system
- agent
- network identity

Minimal shape:

```text
identity
  -> type
  -> id
  -> name?
```

### Target

For direct surfaces, targets should stay direct.

```text
target
  -> agent
  -> thread?
```

If future shared-network surfaces need room or DM targets, that should be added in their own design note rather than baked into the direct-surface contract too early.

### Parts

Parts should be the common multimodal building block.

```text
part
  -> text?
  -> data?
  -> file?
  -> url?
  -> media_type?
  -> filename?
  -> metadata?
```

This is deliberately close to A2A's `Part` model.

### Tasks

Tasks should be optional, but shared.

They matter for:

- A2A
- long-running direct HTTP work
- webhook callback flows
- future shared-network work tracking if that layer chooses to reuse them

Conceptually:

```text
task
  -> id
  -> status
  -> state_message?
  -> last_update_at?
```

### Artifacts

Artifacts should be first-class because direct surfaces need to carry files and structured outputs from day one.

```text
artifact
  -> id
  -> name?
  -> parts[]
  -> append?
  -> last_chunk?
```

This should remain compatible with A2A-style streaming artifact updates.

## Future Compatibility Rules

If we want to avoid painting ourselves into a corner, the direct surfaces should obey these rules.

### Rule 1: Future shared-network surfaces must add topology, not redefine content

A future shared-network surface may add:

- rooms
- DMs
- memberships
- presence
- observation

But it should not redefine:

- what a part is
- what a file is
- what a task is
- what a streamed update is

### Rule 2: Direct surfaces must not require room semantics

`http`, `webhook`, and `a2a` should work with:

- direct target agent
- optional thread or task

They should not require:

- room ids
- memberships
- presence

### Rule 3: A2A alignment should happen at the task and artifact layer

Spawnfile should not force all direct surfaces to look like raw A2A RPC methods.

Instead:

- adopt A2A-like part and artifact semantics
- adopt A2A-like task state semantics
- expose a real A2A surface separately

### Rule 4: HTTP should not be defined by one runtime's private API

If TinyClaw happens to expose useful local endpoints, that is good bridge material.

It is not, by itself, the portable contract.

The direct-surface contract should be Spawnfile-owned and runtime-neutral.

## Spawnfile Agent vs A2A Agent

One distinction matters a lot here:

- a Spawnfile agent is an authored autonomous runtime entity
- an A2A agent is an externally exposed protocol endpoint with an Agent Card and A2A operations

Those are not automatically the same thing.

Possible mappings:

```text
1 Spawnfile agent   -> 1 A2A endpoint
1 Spawnfile agent   -> many exposed surfaces, including A2A
```

So the real design question is not just:

- "should HTTP equal A2A?"

It is also:

- "what is the unit of A2A exposure?"

That exposed unit might be:

- one individual Spawnfile agent
- one individual exposed agent

## Decision: How Close To A2A Should This Be

There are two viable options.

### Option A: A2A-native direct protocol

In this model:

- the canonical direct HTTP API is A2A HTTP+JSON
- the canonical streaming model is A2A streaming
- plain HTTP clients still call the A2A endpoint shape
- the dedicated `a2a` surface is just the standards-compliant exposure of that API

This is stronger than the previous draft and has real advantages:

- no impedance mismatch later
- full standards alignment from day one
- easier interoperability with external agents
- files, tasks, streaming, and discovery come from one mature model

### Option B: A2A-aligned but not literally A2A everywhere

In this model:

- direct HTTP and webhook use a Spawnfile-owned protocol
- the internal envelope family is strongly A2A-derived
- the dedicated `a2a` surface exposes the real full A2A spec separately

This keeps direct non-agent callers simpler, but introduces an adapter boundary between plain HTTP and full A2A.

## Current Lean

The stronger challenge to the earlier note is this:

- because Spawnfile agents are autonomous and externally callable, there is a serious case for making the agent-facing direct HTTP primitive A2A-native

So the new recommendation is:

- do not assume HTTP must be simpler than A2A
- first decide whether each directly exposed agent should also expose an A2A-native surface
- then decide whether plain direct HTTP should be:
  - the same A2A API, or
  - a thinner convenience projection over the same internal model

What still seems clearly true:

- we should not invent something completely different from A2A
- the internal envelope family should stay very close to A2A messages, parts, tasks, artifacts, and events
- webhook can still remain a callback delivery surface even if the canonical direct API becomes A2A-native

## Runtime Overlap That Supports This

The current bundled runtimes overlap more on envelope shape than on protocol shape.

### TinyClaw

TinyClaw already exposes:

- inbound message submission: `POST /api/message`
- outbound responses: `GET /api/responses/pending`
- SSE events: `GET /api/events/stream`
- file references on queued responses

That tells us TinyClaw naturally fits:

- accepted message
- event stream
- artifact or file references

It does not prove that TinyClaw's exact endpoints should be the portable contract.

### PicoClaw

PicoClaw already exposes:

- structured inbound and outbound message types
- media parts
- a shared HTTP webhook server for channels
- a unified message bus

That tells us PicoClaw naturally fits:

- canonical inbound message envelope
- canonical outbound message or artifact envelope
- adapter-based webhook ingress

It does not yet expose one stable generic direct-agent API we should standardize on.

### OpenClaw

OpenClaw already has:

- rich channel and routing surfaces
- plugin-based extension points
- good media and artifact handling

But it does not currently expose a stable generic direct HTTP agent ingress that we should declare as the portable Spawnfile contract.

That tells us:

- the direct contract should target the adapter boundary, not one runtime's current API surface

## A2A-Derived Direct-Surface Definitions

The sections below are concrete enough to guide the next implementation pass.

### 1. Canonical Message Envelope

This should be the common direct-surface input and output unit.

```text
message
  -> message_id
  -> context_id?
  -> task_id?
  -> from
  -> to
  -> parts[]
  -> metadata?
  -> references?
```

Proposed fields:

| Field | Required | Notes |
|------|----------|-------|
| `message_id` | yes | Client-generated or server-generated unique id |
| `context_id` | no | A conversation or request context id; maps well to A2A |
| `task_id` | no | Present when the message belongs to a task |
| `from` | yes | Direct identity object |
| `to` | yes | Direct target object |
| `parts` | yes | One or more multimodal parts |
| `metadata` | no | Arbitrary structured metadata |
| `reference_task_ids` | no | Adopt from A2A where useful |

### 2. Canonical Event Envelope

All direct surfaces should emit events through one event family.

```text
event
  -> event_id
  -> type
  -> timestamp
  -> correlation_id?
  -> context_id?
  -> task_id?
  -> message?
  -> artifact?
  -> error?
  -> metadata?
```

Proposed core event types:

- `message.accepted`
- `message.output`
- `task.status`
- `artifact.update`
- `error`

This is deliberately close to A2A's status update and artifact update events, but with simpler direct-surface naming.

### 3. Task Lifecycle

We should adopt A2A's state model almost directly.

Recommended direct-surface task states:

- `submitted`
- `working`
- `input_required`
- `auth_required`
- `completed`
- `failed`
- `canceled`
- `rejected`

These map cleanly to A2A's task states and cover the direct-surface needs well.

Task shape:

```text
task
  -> task_id
  -> context_id?
  -> status
  -> status_message?
  -> metadata?
```

### 4. Part Model

We should stay extremely close to modern A2A here.

Recommended part shape:

```text
part
  -> exactly one of:
       text
       raw
       url
       data
  -> media_type?
  -> filename?
  -> metadata?
```

That is the strongest cross-surface and cross-runtime overlap we have.

### 5. Artifact Model

We should also stay very close to A2A here.

Recommended artifact shape:

```text
artifact
  -> artifact_id
  -> name?
  -> description?
  -> parts[]
  -> append?
  -> last_chunk?
  -> metadata?
```

The extra `append` and `last_chunk` flags are important for streaming updates.

### 6. HTTP Semantics

The direct HTTP surface should not be a copy of TinyClaw's queue API.

The first portable shape should be:

- `POST /v1/messages`
- `GET /v1/events/stream`
- `GET /v1/tasks/{task_id}`
- `GET /v1/messages/{message_id}`

Behavior:

- `POST /v1/messages` accepts a canonical message envelope
- immediate response should return:
  - `message_id`
  - optional `context_id`
  - optional `task_id`
  - whether the request was accepted synchronously
- further output should arrive via:
  - SSE stream, or
  - task polling, or
  - webhook callback if configured

This is more general than raw A2A method names, but close enough that A2A mapping stays straightforward.

### 7. Streaming Contract

First recommendation:

- SSE first
- WebSocket later if needed

Why SSE first:

- A2A already embraces SSE for streaming and async
- TinyClaw already exposes SSE
- it is simpler than WebSocket for the first portable contract

The stream should carry canonical event envelopes.

### 8. Webhook Semantics

Webhook should be callback delivery of canonical events.

Minimum model:

- caller registers callback endpoint as part of the request or client config
- runtime emits canonical events to that endpoint
- signatures should be supported, but can be optional in the very first local-only pass

Webhook payloads should use the same event envelope as SSE.

### 9. Auth Model

The first auth model should stay simple.

Recommended initial modes:

- none, for local/dev
- bearer token, for direct HTTP and SSE
- signed webhook delivery, for webhook callbacks

A2A-specific auth and agent-card security schemes belong to the dedicated A2A surface.

### 10. Error, Retry, And Idempotency

Direct surfaces should define:

- `correlation_id`
- `idempotency_key`
- `causation_id`

And a portable error shape:

```text
error
  -> code
  -> message
  -> retryable
  -> details?
```

That is more transport-agnostic than A2A's method responses, while still fitting A2A mapping later.

### 11. Minimum Runtime Adapter Contract

To support the direct surfaces honestly, a runtime adapter should be able to do these things:

1. accept one canonical inbound message envelope
2. emit canonical events
3. emit artifact updates or file references
4. preserve `message_id`, `context_id`, and `task_id`
5. support SSE or an adapter-managed equivalent

If a runtime cannot do that, the direct surface should not be declared portable for that runtime yet.

## What Still Needs To Be Decided

The core shape is now defined enough to proceed, but a few practical choices still need a final call:

- whether `POST /v1/messages` should always be async-first
- whether tiny inline files should be allowed in `raw` for HTTP, or require separate upload
- whether webhook signatures are mandatory in v0.1 or only recommended
- whether `context_id` is caller-supplied, server-supplied, or both
- whether `message.output` and `task.status` should sometimes be collapsed in the stream

Those are implementation-level choices. They are narrower than the architectural questions above.

## Example Shape

This is not final schema. It is only a mental model.

```text
direct request
  -> message
  -> parts[]
  -> optional task request

direct response
  -> accepted
  -> event stream or callback
  -> reply messages
  -> artifact updates
```

A simple flow:

```text
+--------+      +------------------+      +------------------+
| client | ---> | /messages        | ---> | agent runtime    |
+--------+      +------------------+      +------------------+
    ^                     |                          |
    |                     v                          v
    |              +------------------+      +------------------+
    +--------------| events / webhook | <----| reply / artifact |
                   +------------------+      +------------------+
```

## What This Implies For Spawnfile

Before we finalize the portable `http` surface, we should define:

1. the shared envelope family
2. the direct-surface semantics for `http`
3. the callback or stream semantics for `webhook`
4. the direct A2A surface boundary
5. the exact extension points for future shared-network surfaces

That gives us the right dependency direction:

```text
shared envelope family
    -> http
    -> webhook
    -> a2a
```

And only later:

```text
shared envelope family
    -> future shared-network surface
```

## Recommended Next Step

The next design package should probably be two sibling notes:

1. direct surface envelope draft
2. shared-network topology draft

That keeps us from mixing:

- "what is a message"

with:

- "how do rooms and shared networks behave"
