# CAUSAL.md — Noopolis causal event envelope and reconciliation

Status: evolving. Normative for the `noopolis.causal-event.v1` wire envelope
and the shared read/verify implementation in `@noopolis/stele`. Informs, but
does not replace, the per-repo native producer types described below.

## 1. Purpose

Every Noopolis authority (`simfile`, `moltnet`, `mneme`, `daimon`) participates
in causal chains that cross process and repo boundaries: a message triggers a
memory recall, which feeds a turn, which produces a reply message. No single
authority can see the whole chain. The causal event envelope is the shared,
serialized contract that lets a separate reconciler reconstruct that chain
after the fact from independently emitted JSONL streams.

That reconciler is Stele. Simfile's observer verifies the declared artifact
set, passes serialized events and declared stream finals to Stele, and applies
run-specific verdict policy to Stele's result. Stele is not an emitter,
runtime service, artifact collector, or verdict owner.

The wire JSON is the contract. Reconciliation consumes serialized records —
never in-process types from any one repo. Siblings do not vendor this schema;
they each write their own native type (zod in the TS repos, a hand-written
struct + `Validate()` in Go, per the Moltnet stdlib rule) and root's
conformance harness validates what actually goes out on the wire against
`specs/causal-event.v1.schema.json`.

## 2. Envelope shape

```ts
export interface CausalEventEmitter {
  system: "simfile" | "moltnet" | "mneme" | "daimon";
  stream_id: string;
  seq: number;
}

export interface CausalEvent<TPayload = Record<string, unknown>> {
  version: "noopolis.causal-event.v1";
  run_id: string;
  event_id: string;
  emitter: CausalEventEmitter;
  type: string;
  principal_id: string;
  recorded_at: string;
  cause_event_ids: string[];
  payload: TPayload;
}
```

Go's `pkg/protocol` carries the same fields, with `Payload json.RawMessage`,
`RecordedAt time.Time`, and a `func (e CausalEvent) Validate() error` method
instead of a schema library.

## 3. Field rules

- **`version`** — always the literal `noopolis.causal-event.v1` for this
  generation of the envelope.
- **`run_id`** — shared by every authority in a single run. Every container
  the root compiler assembles is stamped with the same `NOOPOLIS_RUN_ID`
  environment variable (see `src/runtime/common.ts`); adapters read `run_id`
  from that environment variable, never from model output, so all four
  authorities agree on it without any cross-repo handshake.
- **`event_id`** — format `<system>:<local>`, where `<system>` matches
  `emitter.system` and `<local>` is opaque to every consumer except the
  emitting system. Globally unique and immutable: once assigned, an
  `event_id` must never be reused for a different fact. A record that
  reuses an `event_id` with a different canonical-JSON hash is a
  **divergent** record (see §5), not a correction.
- **`emitter.stream_id` / `emitter.seq`** — `seq` is a 1-based sequence
  number, contiguous within `(run_id, system:stream_id)`. Each authority
  owns exactly one contiguous counter per stream it emits (for example
  Moltnet's `network:<networkID>`, Daimon's `agent:<agentId>`). Gaps are
  detected by `ecosystem/stele/src/seq.ts` and feed the reconciler's
  `partial` / `stale` states.
- **`principal_id`** — the authenticated principal responsible for this
  event. Normative grammar (schema `pattern: ^(agent|operator|system):.+`,
  `src/ledger/principal.ts`):

  ```text
  agent:<agentId>                     — an authenticated agent identity
  operator:<credentialKey|name>       — an authenticated operator/static credential
  system:<system>[.<component>]       — a system-level principal, e.g. system:simfile.world
                                         for the deterministic world clock
  system:simfile.controller.<controller_id> — a recoverable simfile controller identity
  ```

  This grammar is a CLOSED cross-repository contract (B169 D1, conformed
  across repositories by B209) and must not be widened locally. `agent`,
  `operator`, and `system` are trust classes, not producer names; producer
  identity lives in `emitter.system`. A simfile controller appends its
  `<controller_id>` verbatim to `system:simfile.controller.` with no
  escaping. Decoding is a total fixed-prefix strip, so the encoding is
  injective and two controller identities remain distinguishable from the
  envelope alone, without a payload join.

  Origin determines the namespace (B169 D3). Agentic attempts use the
  `agent` trust class when their principal is bare; controllers always use
  the recoverable controller form above. External and replay attempts mint
  their origin-specific simfile namespace only for a bare principal and
  preserve an already-grammatical principal verbatim, so replaying
  `agent:nora` leaves it exactly `agent:nora`.

  `system:moltnet.anonymous` is moltnet's stamped principal for its
  unauthenticated dev-mode case (no authn claims on the request context at
  all, see `ecosystem/moltnet/internal/rooms/causal.go`). It is
  grammar-valid but conformance (`src/ledger/principal.ts`'s
  `isAuthenticatedPrincipal`, wired into `runSyntheticConformance`)
  explicitly **rejects** it, along with any bare id (no prefix) and the
  literal string `anonymous`: `principal_id` must always name a real
  authenticated identity, never a placeholder for "no principal". A
  principal is minted only by a trusted layer — root's container env
  (`NOOPOLIS_RUN_ID` precedent, `src/runtime/common.ts`) plus each
  authority's own per-agent harness config or authn claims (daimon's
  `AgentStartInput.id`, mneme's `MemoryToolExecutionContext.principal`,
  moltnet's `authn.Claims` from a verified token) — **never** from
  `request.From`, tool arguments, request bodies, or model output.
  Diagnostics and reconciliation both treat `principal_id` as a trust
  anchor: every node in a reconstructed chain must carry one.

  For daimon's turn events (`turn.input.submitted`/`turn.output.completed`),
  `principal_id` must additionally equal `emitter.stream_id` exactly (both
  are `agent:<agentId>`) — the agent whose stream this is must be the agent
  the event is attributed to. This does NOT apply to daimon's control-wake
  events (`control.wake.accepted`/`control.wake.denied`, minted by root's
  operator-control endpoint, see `src/runtime/pi/appControlSource.ts`):
  their stream is the *target* agent being woken, but their principal is
  the *operator* who requested the wake — an intentional mismatch.
- **`recorded_at`** — an ISO 8601 timestamp, diagnostics only. The
  reconciler never uses `recorded_at` to order events or to decide trust;
  ordering and trust come entirely from `cause_event_ids` and `seq`.
- **`cause_event_ids`** — direct parents only. A conforming cause id has the
  form `<namespace>:<local>` (B169 D4, conformed across repositories by
  B209). Cause namespaces are OPEN: foreign namespaces are legal, while a
  bare id is nonconforming. Event ids remain on their separate closed
  recognized-authority grammar.

  Validation of a cause id depends on WHICH SIDE is validating it. INGEST
  (Stele's `parseCausalJsonl` and root's conformance) reads other systems'
  output and MUST admit a bare cause id so `stitchInteractionChain` can
  repair it; discarding there destroys the evidence the repair stage exists
  to recover. This is what D4's "never discard the carrying event" sentence
  governs. Root reports a still-malformed cause only AFTER stitching,
  without filtering or discarding the carrying event.

  SEALING (the bundle preflights in Stele, Moltnet, and Mneme) is a producer
  checking its own artifact before freezing it. A sealed artifact carrying
  a bare cause is a producer-side defect and is REJECTED, because this is the
  last moment the producer can still fix it. **Be liberal in what you accept
  from others, strict in what you seal yourself.** Foreign namespaces are
  legal on BOTH sides; the asymmetry applies only to bare ids. The B209
  corpus pins both readings: `reject-bare-cause-id` for sealing and
  `accept-foreign-cause-namespace` for the foreign case.

  The JSON Schema deliberately has no `pattern` on
  `cause_event_ids.items`, so the final-wire grammar can never become an
  ingest admission gate.

  Cause-id uniqueness remains a hard parse rejection, and a present
  cross-run cause remains a hard bundle-preflight rejection. No `trace_id`
  or transitive closure is carried in the envelope; the reconciler rebuilds
  the chain by walking `cause_event_ids` backward one hop at a time.
- **`payload`** — event-type-specific facts. Each event `type` has a
  documented minimum key set (for example `message.accepted` needs
  `message_id` and `content_sha256`); the conformance harness enforces
  those minimums, not the JSON Schema itself, so new payload fields can be
  added without a schema revision.

## 4. Reconciliation states

Stele's reconciler (`ecosystem/stele/src/reconcile.ts`) assigns exactly one
state to every event it can index, in this precedence order (first match
wins):

| State | Meaning |
|---|---|
| `divergent` | The same `event_id` (or the same `(run_id, system:stream_id, seq)` slot) appears more than once with a different canonical-JSON hash; a cross-store fact disagrees; or the graph contains an impossible structural claim such as a cross-run edge, self-cause, or cycle. |
| `unknown` | The event's `cause_event_ids` references an id whose `system` has no ingested events at all — the reconciler has no telemetry from that authority and cannot say whether the reference is forthcoming or lost. |
| `partial` | The event's `cause_event_ids` references an id that is missing, but the referenced system is otherwise represented in the ingested set — the specific fact simply has not arrived yet (for example a dropped `turn.output.completed`). |
| `stale` | A declared final `seq` for a stream exceeds the maximum `seq` actually ingested for that stream (there are known, not-yet-ingested events), or a dangling cause resolves to such a stream. |
| `complete` | The event and its complete transitive ancestor closure are same-run, acyclic, present through declared final positions, and free of divergence. |

Local record state and transitive chain state MUST be distinguishable in the
result. A directly present parent does not make a child complete when that
parent has an incomplete, stale, unknown, or divergent ancestor.

Sequence-contiguity results and declared final positions MUST participate in
reconciliation rather than remain a separate diagnostic. Production callers
MUST provide the final positions declared by each sealed authority stream.

Reconciliation remains deterministic and should stay linear in events plus
edges. It MUST scope indexes by run, detect cycles without unbounded
recursion, and never synthesize a missing cause.

Stele owns the executable reconciliation conformance tests. Downstream
projects consume its published result and must not substitute fixture-local
graph repair or producer-specific stitching.

## 5. Divergence detail

Two independent triggers both resolve to `divergent`:

1. **Duplicate identity** — the same `event_id` is seen more than once
   with a different canonical-JSON hash (keys sorted recursively before
   hashing, so field order never causes a false divergence).
2. **Conflicting fact hashes across stores** — for example a
   `moltnet:message.accepted` payload's `content_sha256` disagrees with the
   `input_content_sha256` a `daimon:turn.input.submitted` event recorded for
   the same `message_id`. This is the only place where the reconciler reads
   across event types rather than walking `cause_event_ids`.

## 6. What lives where

- `specs/causal-event.v1.schema.json` — the canonical JSON Schema (draft
  2020-12). Root validates against it; siblings do not vendor it.
- `ecosystem/stele/src/envelope.ts` — the shared TS `CausalEvent` type,
  parser, validator, canonical serializer, and hash implementation.
- `ecosystem/stele/src/seq.ts` — the per-`(run_id,
  system:stream_id)` contiguity checker.
- `ecosystem/stele/src/reconcile.ts` — the pure shared reconciler described
  in §4-§5, plus `traceCausesBackward` for walking a chain from an effect
  back to its roots using `cause_event_ids` only.
- `src/ledger/principal.ts` — the `principal_id` grammar parser/validator
  (`parsePrincipal`, `isAuthenticatedPrincipal`) described above, plus the
  per-event conformance checks built on it (`PRINCIPAL_DISCIPLINE_CHECKS`).
- `src/ledger/emitters.ts` — root producer helpers; emission does not belong
  in Stele.
- `src/ledger/conformance.ts` — validates seeded/synthetic fixture JSONL
  against the schema, seq contiguity, payload minimums, and (via
  `runSyntheticConformance`) the principal grammar/consistency discipline.
  The synthetic harness in this repo never silently skips a source: an
  empty source list or a failed parse is always reported as an issue,
  never treated as a pass.
