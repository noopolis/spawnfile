# Spawnfile Direction

Status: active research direction
Date: 2026-03-29

This document captures the current design direction for Spawnfile based on 21 structured design discussions. It serves as the roadmap for the evolving v0.1 spec.

---

## 1. Team Coordination

**Status:** shipping now

**Summary:** Teams gain real coordination semantics beyond metadata grouping. The `structure` block is flattened to top-level `mode`, `lead`, and `external`. Agents get an optional `description` field. The compiler emits context-scoped `TEAM.md`, roster, and team-card artifacts so agents know which team context they are acting in. Hierarchical and swarm topologies ship first.

**Key decisions:**
- Flattened team schema: `mode: hierarchical | swarm`, `lead`, `external` at top level (was nested under `structure`).
- New optional `description` field on agents — short summary for roster presentation. Falls back to `docs.identity` if omitted.
- Context-scoped rosters are emitted under `{workspace}/.spawnfile/rosters/`, with root aliases only for agents that have exactly one direct team membership.
- Agents are described in natural language, not classified by capability tags. Descriptions are the coordination signal.
- No `capabilities` block, no `expose` filter — dropped in favor of natural language descriptions that LLMs reason about.
- Runtime adapters expose their system-instruction surface so the compiler can point agents at generated team-context orientation. Spawnfile does not inject a team router or team-message tool.

**Open questions:**
- Roster refresh at runtime vs static compile-time artifact only.
- Inbox ordering guarantees under concurrent writes.
- Message size limits and inbox cleanup semantics.

---

## 2. Direct Surfaces: HTTP

**Status:** deferred out of the v0.1 alpha portable surface contract

**Summary:** Portable HTTP ingress is not part of the current alpha surface schema. TinyClaw and other runtimes may have native HTTP APIs, but Spawnfile does not standardize those as a portable agent surface yet.

**Key decisions:**
- `surfaces.http` is removed from the v0.1 alpha schema.
- Team-level HTTP entrypoints are not a replacement for the removed team router.
- Runtime-native HTTP remains runtime-specific until a real portable ingress contract is designed.

**Open questions:**
- Whether `POST /v1/messages` should always be async-first.
- Whether webhook signatures are mandatory or recommended.
- Whether `context_id` is caller-supplied, server-supplied, or both.

---

## 3. Direct Surfaces: Webhook

**Status:** shipping now

**Summary:** Webhook is a callback delivery surface for agent events. It shares the same envelope and event types as HTTP/SSE but pushes to caller-owned endpoints.

**Key decisions:**
- Fire-and-forget push of canonical event envelopes to registered callback URLs.
- Same event types as SSE: `message.output`, `task.status`, `artifact.update`, `error`.
- HMAC signature support for delivery verification.
- Webhook payloads use the same event envelope as SSE streams.

**Open questions:**
- Retry policy and delivery guarantees (at-least-once vs best-effort).
- Whether callback registration happens per-request or per-client config.

---

## 4. Direct Surfaces: A2A

**Status:** next up

**Summary:** A2A surfaces expose agents as standards-compliant A2A endpoints with Agent Card discovery. Dual-mode protocol: standalone agents speak A2A natively, team members use lightweight internal protocol with A2A at the boundary.

**Key decisions:**
- Agent Card generated from manifest metadata at compile time (name, description, capabilities mapped to skills).
- Standalone agents get direct A2A handlers; team members get internal protocol with A2A adapter at the coordinator boundary.
- Internal message format is A2A-shaped but lifecycle-free (no task_id, no status fields).
- A2A version pinned in surface declaration; compiler supports multiple versions.
- Implementation sequence: Agent Card generation first, then standalone sync, then SSE streaming, then team internal protocol, then boundary adapter.

**Open questions:**
- Bidirectional streaming (A2A lacks support; internal protocol should not preclude it).
- Push-based Agent Card registration with directories.
- Whether the internal protocol gets a formal name or stays implicit.

---

## 5. Channels Topology

**Status:** next up

**Summary:** Named subgroups within teams for scoped messaging. Channels are an alternative topology mode alongside hub and mesh, not a layer on top of them.

**Key decisions:**
- Schema defined but implementation deferred; compiler rejects `topology: channels` with a clear error.
- Channel field mandatory in message envelope when topology is channels.
- Reachability scoped to shared channel membership.
- Hub, mesh, and channels are mutually exclusive topology modes.

**Open questions:**
- Whether channels need a leader concept or are always peer-to-peer within the channel.
- Cross-channel messaging rules.

---

## 6. Envelope Family

**Status:** next up

**Summary:** Spawnfile-native envelope with a three-layer versioning model. A2A compatibility expressed as a profile mapping, not a structural dependency.

**Key decisions:**
- Three layers: frame version (integer, rarely changes), capabilities (independently evolvable feature sets), profiles (named bundles for negotiation).
- Every envelope on the wire carries `frame` and `profile` fields.
- A2A alignment is a profile (e.g., `a2a-draft-3`, `a2a-1.0`), not the base format.
- Spawnfile-native envelope types and field names defined independently; A2A is an adapter boundary.
- Profile registry maintained as `profiles.yaml` analogous to `runtimes.yaml`.
- Deployed agents never break without a recompile; old profiles deprecated, not removed.

**Open questions:**
- Negotiation mechanism for peer-to-peer (A2A, network) vs implicit for client-server (HTTP/webhook).
- How the network surface carries envelopes opaquely while reading frame/profile for routing.

---

## 7. Agent Network Surface

**Status:** next up

**Summary:** A lightweight, runtime-agnostic network substrate for agent rooms, DMs, identities, and human observation. Separate project from Spawnfile but defined alongside A2A surfaces in the days after HTTP and A2A ship. NOT deferred 90 days as originally recommended -- project direction has accelerated this.

**Key decisions:**
- The network surface is an additional surface, not the default transport under all agents.
- Core entities: identity, room, DM thread, message/event, artifact, membership.
- Local-first deployment: single Docker container, SQLite, SSE/WebSocket.
- Bridge-first runtime integration: bridge process per runtime, not native plugins initially.
- Spawnfile integrates with the network as a surface; Spawnfile does not become the network.
- Envelope family shared with direct surfaces; the network layer is transport-agnostic for payload semantics.

**Open questions:**
- Implementation language (Go recommended but deferred until evidence demands it).
- Whether internet mode is central-hub first or federation-ready from day one.
- Smallest useful identity model.
- UI embedded in server or split into separate frontend.

---

## 8. Surface Extensibility

**Status:** future

**Summary:** A surface descriptor meta-schema enables new surfaces without spec revisions. Three-tier governance separates spec-normative, registry-published, and local/private surfaces.

**Key decisions:**
- Tier 1 (spec-normative), Tier 2 (registry-published, reviewed), Tier 3 (local/private, warning emitted).
- Surface descriptors declare transport class from spec-defined enum: request-response, persistent-bidirectional, fire-and-forget, poll-based.
- All surfaces represented internally as descriptors, including Tier 1 (single compiler code path).
- Dispatch keys namespaced by surface name; duplicates are compile-time errors.
- Base envelope inviolable; transport metadata namespaced under `envelope.transport.<surface>`.
- Non-Tier-1 surfaces version-pinned in manifests.

**Open questions:**
- Registry infrastructure design and hosting.
- Conformance test generation from descriptors.
- Graduation criteria from Tier 2 to Tier 1.

---

## 9. Observability

**Status:** future

**Summary:** Structured agent observability through stdout logging, heartbeat events, and a health vocabulary that goes beyond process liveness.

**Key decisions:**
- Health vocabulary: healthy, degraded, overloaded, unhealthy, failed.
- `spawnfile observe` CLI command for real-time agent monitoring.
- Heartbeat events emitted on a regular cadence.
- Structured stdout logging as the primary observability channel.

**Open questions:**
- Health aggregation semantics for teams.
- Whether observability surfaces are well-known or declared.

---

## 10. Surface Router

**Status:** evolving with surfaces

**Summary:** A generated build artifact (not a runtime framework) that handles HTTP routing, health aggregation, and topology enforcement for teams.

**Key decisions:**
- Router is compile-time generated, not a standalone runtime service.
- Topology enforcement for internal team coordination (validates sender/receiver against reachability matrix).
- Extends to support team routing: external members, nested team forwarding.
- For A2A coordination, topology enforcement is advisory (reflected in roster, not infrastructure-enforced).

**Open questions:**
- Router behavior when surfaces scale beyond HTTP (webhook callbacks, A2A, the network surface).
- Multi-threaded write synchronization for file-based inboxes.

---

## 11. Conformance Testing

**Status:** future

**Summary:** A `@spawnfile/conformance` package with capability-granular testing that gates spec promotion from draft to normative.

**Key decisions:**
- Sections move from draft to normative only with 2 passing implementations.
- Conformance tests are per-capability, not per-surface.
- Surface descriptors should be expressive enough to generate conformance test fixtures.

**Open questions:**
- Package structure and distribution.
- Whether conformance gates apply to Tier 2 registry surfaces.

---

## 12. Identity Model

**Status:** future (will be defined with the network surface)

**Summary:** Minimal per-surface identity for direct surfaces. The network surface should have structured durable identity from day one.

**Key decisions:**
- Direct surface identity is minimal: type, id, optional name.
- Identity types: human, system, agent, network identity.
- Optional origin annotation for cross-surface tracing.
- Network surface identities are durable and structured; direct surface identities are ephemeral.

**Open questions:**
- Whether identities are globally unique or scoped to surface/network.
- Cross-deployment identity federation.

---

## 13. Skill and MCP Evolution

**Status:** future

**Summary:** Skill packaging and registry for runtime extensibility. Capability slots formalize what agents can do beyond static declarations.

**Key decisions:**
- Capabilities on agent manifests are coordination hints (id + description), not function signatures.
- Formal input/output schemas deferred; likely tied to A2A skill schema later.
- MCP treated as one compatibility bridge, not the entire architecture.

**Open questions:**
- Dynamic tool discovery vs static declaration.
- Skill registry design and distribution mechanism.

---

## 14. State and Memory

**Status:** future

**Summary:** Well-known surfaces for persistent state (`team_state`) and agent memory (`agent_journal`). Clear distinction between shared coordination state and private agent memory.

**Key decisions:**
- `team_state` is a shared coordination surface; `agent_journal` is private agent memory.
- State surfaces live at `{workspace}/.spawnfile/surfaces/`.
- Memory vs state: state is coordination-visible, memory is agent-private.

**Open questions:**
- What survives a container restart.
- Persistence backend (filesystem, volume, external store).

---

## 15. Agent Lifecycle

**Status:** future

**Summary:** Health semantics, fallback models, restart recovery, and team-level failover beyond basic process management.

**Key decisions:**
- Health vocabulary shared with observability (healthy/degraded/overloaded/unhealthy/failed).
- Fallback model support for graceful degradation.
- Team failover when individual agents fail.

**Open questions:**
- Restart recovery semantics (cold start vs warm resume).
- Context window exhaustion handling.

---

## 16. Multi-Container

**Status:** future

**Summary:** Transport abstraction and Docker Compose target for teams that span multiple containers.

**Key decisions:**
- "One compile = one container" is the default but not the only target.
- Docker Compose as the first multi-container compilation target.
- Resource annotations for memory, CPU, GPU hints.

**Open questions:**
- When multi-container is required vs optional.
- Kubernetes target timeline.

---

## 17. Security

**Status:** future

**Summary:** Secret leakage prevention, secure-by-default surface/provider configuration, and audit tooling.

**Key decisions:**
- `spawnfile audit` command for security review.
- Spawnfile-owned generated services should be secure by default, with no open endpoints without explicit config.
- Secret references (`$SECRET_NAME`) never resolved into compiled output.

**Open questions:**
- Secret rotation semantics.
- Network-level isolation between agents in the same deployment.

---

## 18. Manifest Composability

**Status:** future

**Summary:** Packages, registries, and lock files for cross-project agent sharing.

**Key decisions:**
- Agent manifests should be importable across projects.
- Lock files for reproducible resolution of external references.

**Open questions:**
- Package format and registry design.
- Versioning semantics for shared agent packages.

---

## 19. Developer Experience

**Status:** ongoing

**Summary:** `spawnfile dev` for local development without Docker, templates for quick starts, and a REPL for interactive agent testing.

**Key decisions:**
- `spawnfile dev` is critical for adoption; zero-to-running-agent in 5 minutes is the target.
- Templates for common agent patterns.
- `spawnfile repl` for interactive testing.
- `spawnfile observe` for real-time monitoring.

**Open questions:**
- Hot-reload semantics for `spawnfile dev`.
- Template distribution mechanism.

---

## 20. Spec Evolution Governance

**Status:** future

**Summary:** Per-feature maturity tiers, forward-compatibility rules, and the `x-` namespace for experimental extensions.

**Key decisions:**
- Conformance gates: sections move from draft to normative with 2 passing implementations.
- `x-` namespace for experimental manifest fields.
- Forward-compatibility: unknown fields preserved, not rejected.
- No normative spec text without corresponding implementation.

**Open questions:**
- Formal deprecation process and timelines.
- How compatibility and versioning are communicated once Spawnfile has a real v1 user base.

---

## 21. Competitive Positioning

**Status:** ongoing strategic direction

**Summary:** The Spawnfile manifest format becoming a standard is the long-term moat. Time-to-production is the key adoption metric. Model-agnostic and self-hosted are the differentiators against CrewAI, AutoGen, and LangGraph.

**Key decisions:**
- Format as the moat: Spawnfile as the "Dockerfile for agents."
- Model-agnostic: no lock-in to any provider or runtime.
- Self-hosted first: no required cloud dependency.
- Time-to-production over feature count.

**Open questions:**
- When to pursue ecosystem partnerships.
- Which runtime integrations to prioritize beyond the bundled three.

---

## Implementation Priority

The work ships in this order:

1. **Team coordination + Moltnet networks + webhook metadata** -- Context-scoped rosters, hierarchical/swarm topology, nested-team representatives, Moltnet team-network lowering, and declared webhook/surface metadata. Shipping now.

2. **A2A surface + envelope family** -- Agent Card generation from manifests, dual-mode protocol (standalone A2A, team internal + boundary adapter), three-layer envelope versioning with profile system. Ships immediately after HTTP.

3. **Agent network surface** -- Rooms, DMs, identities, bridge-first runtime integration. Defined in the days after HTTP and A2A are done. Ships as a companion project with Spawnfile surface integration.

4. **Everything else** -- Surface extensibility, conformance testing, multi-container, security, manifest composability, state/memory, lifecycle, and spec governance. Prioritized by adoption pressure and real-world usage patterns. Developer experience improvements are ongoing throughout.
