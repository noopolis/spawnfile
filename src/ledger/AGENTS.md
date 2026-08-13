# Ledger Guide

This folder owns the producer/product side of the `noopolis.causal-event.v1`
envelope contract on the root side: the B62 principal grammar checks, the
synthetic conformance harness, and (B92) real-mode conformance against the
four sibling repos' actual fixture emitters. See `specs/CAUSAL.md` for the
normative envelope semantics this folder implements.

The READ/VERIFY side of the contract — the `CausalEvent` type + zod
validator + `parseCausalJsonl` + canonical hashing (`envelope.ts`), the pure
reconciler + backward cause-chain tracer (`reconcile.ts`), and the per-stream
seq contiguity checker (`seq.ts`) — moved out to the narrow shared package
`@noopolis/stele` (`ecosystem/stele`), so Simfile can reconcile causal
chains without importing Spawnfile internals (Decision 20 / contracts.md).
Every file in this folder that needs those symbols imports them directly
from `@noopolis/stele`; `index.ts` re-exports `@noopolis/stele` so every
existing external consumer of `../ledger/index.js` keeps working unchanged.
`stitchInteractionChain` (in `conformance.ts`) is fixtures-only and must
never move to the shared package — it is not importable by an observer.

## Structure

```text
src/ledger/
├── index.ts                  # Barrel: ledger modules plus @noopolis/stele
├── causeNamespace.ts         # B169 D4 report-only cause namespace check
├── causeNamespace.test.ts
├── principal.ts              # B62 principal grammar parser/validator + per-event conformance checks
├── conformance.ts              # Schema + seq + payload-minimum validation, real-mode chain stitch/proof
├── emitters.ts                  # Real sibling emitter invocation contract (by path, never npm run)
├── causalConformanceCli.ts       # `npm run test:causal-conformance` entry point (excluded from coverage)
├── principal.test.ts
├── conformance.test.ts
├── emitters.test.ts
└── realConformance.test.ts       # stitchInteractionChain + runRealConformance (injected exec, pure)
```

The envelope/reconcile/seq modules and their tests now live in
`ecosystem/stele/src/` (`envelope.ts`, `reconcile.ts`, `seq.ts`, plus their
`*.test.ts` files and the package's own `index.ts` barrel) — see
`ecosystem/stele/AGENTS.md`.

## Rules

- The wire JSON is the contract. Nothing here should assume it is
  reconciling in-process objects from another repo — always go through
  `parseCausalJsonl` or `causalEventSchema` (both from `@noopolis/stele`)
  on serialized text/records.
- Keep the B169 INGEST/SEALING split explicit: Stele's `parseCausalJsonl` and
  root conformance ingest other systems' output, admitting bare causes so
  `stitchInteractionChain` can repair them, while Stele/Moltnet/Mneme bundle
  preflights seal producer artifacts and reject bare causes. Be liberal in
  what you accept from others, strict in what you seal yourself; foreign
  namespaces remain legal on both sides.
- `run_id` and `principal_id` are never read from model output. `run_id`
  comes from the `NOOPOLIS_RUN_ID` container environment variable
  (`src/runtime/common.ts` for Spawnfile-compiled workloads; `EMITTER_RUN_ID`
  in `emitters.ts` for the B92 conformance run itself);  `principal_id`
  comes from each authority's own authenticated identity.
- `reconcileEvents`/`traceCausesBackward` (`@noopolis/stele`) stay pure
  functions over already-parsed `CausalEvent[]` — no I/O, no fixture
  loading. `conformance.ts` owns fixture text and reports issues; it never
  throws on a bad fixture, it collects issues.
- `runSyntheticConformance` validates seeded/synthetic fixture JSONL text
  passed in by the caller. `runRealConformance` (B92) is the real-mode
  counterpart: it collects the four real sibling emitters through
  `emitters.ts`, runs the same schema/minimums/seq-contiguity validation
  core (`validateConformanceSources`), then stitches them into one
  interaction chain (`stitchInteractionChain`) and reconciles it. Both
  treat a missing/failed source as a reported issue, never a silent skip.
- `@noopolis/stele`'s `envelope.ts` defines `PRINCIPAL_GRAMMAR_SOURCE` — the
  single source of truth for the `^(agent|operator|system):.+` grammar
  (specs/CAUSAL.md §3, `specs/causal-event.v1.schema.json`'s
  `principal_id.pattern`) — and enforces it directly on `causalEventSchema`'s
  `principal_id` field via `z.string().regex(new RegExp(PRINCIPAL_GRAMMAR_SOURCE))`.
  Every wire record is grammar-checked at parse time
  (`parseCausalJsonl`/`validateCausalEvent`), in both synthetic and real
  modes, before it ever reaches conformance-layer checks. `principal.ts`
  imports (never redefines) this constant, from `@noopolis/stele`.
- `principal.ts` owns the B62 principal grammar (`specs/CAUSAL.md` §3):
  `parsePrincipal`/`isAuthenticatedPrincipal` parse and validate a
  `principal_id` (built on `@noopolis/stele`'s `PRINCIPAL_GRAMMAR_SOURCE`), and
  `PRINCIPAL_DISCIPLINE_CHECKS` (`checkPrincipalGrammar` +
  `checkStreamPrincipalConsistency`) are the per-event conformance checks
  built on top of them. `validateConformanceSources` takes an optional
  `extraChecks: EventCheck[]` parameter; both `runSyntheticConformance` AND
  `runRealConformance` (as of the B62 fix) pass `PRINCIPAL_DISCIPLINE_CHECKS`
  — the real `npm run test:causal-conformance` path now has the same teeth
  as the synthetic one. `checkStreamPrincipalConsistency` in particular has
  no envelope-schema equivalent (it checks cross-field consistency, not
  grammar), so wiring it into the real path is what actually closes the gap:
  `realConformance.test.ts`'s hand-authored fixtures are kept grammar-
  compliant (`agent:fixture-agent`, `system:simfile.world`, etc.) for exactly
  this reason, and it has an explicit "reports an issue for a bare/anonymous
  principal via runRealConformance" proof pair. `DEFAULT_PAYLOAD_MINIMUMS`
  (shared by both paths, safe to extend) also carries the three B62 denial-
  event minimums: `message.denied`, `memory.write.denied`,
  `control.wake.denied`.
- `emitters.ts`'s `EMITTER_SPOOF_SPECS`/`toSpoofEmitterSpec` are the B62
  adversarial "spoof mode" counterpart to `EMITTER_SPECS` (`--spoof`
  appended to each sibling's argv, the convention daimon's own
  `npm run emit-causal-fixture:spoof` already uses). Deliberately not part
  of the default `EMITTER_SPECS` list `causalConformanceCli.ts` invokes,
  since not every sibling has a spoof-capable fixture script yet.
- `emitters.ts` never shells through `npm run` (its banner pollutes
  stdout-jsonl output) — every `EmitterSpec.command` is a direct argv
  invoking each sibling's own `tsx`/`go` binary by path. `collectEmitterFixtures`
  takes an injectable `exec`; only `causalConformanceCli.ts` uses the real
  one (`realExec`), so `npm test` stays fully in-process and hermetic.
- `stitchInteractionChain` is pure and rewrites ONLY
  `cause_event_ids`/`payload.input_message_ids`/`payload.input_content_sha256`
  — every other field of every event passes through byte-identical. It
  asserts (never rewrites) that daimon's real `turn.output.completed`
  already causes from its own `turn.input.submitted`.
- `npm run test:causal-conformance` (`causalConformanceCli.ts`) is the only
  place that actually spawns the real emitters end to end; it is excluded
  from coverage thresholds like `src/cli/index.ts`.
- Keep files under 400 lines; split further before that limit.
