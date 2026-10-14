# Prompt Optimization

Owns candidate proposals, train feedback, editable components and selection.

- Use the real DSPy bridge through a versioned public protocol. Do not silently
  substitute direct GEPA or rebuild a native agent loop as a DSPy program.
- Map multi-file editable components explicitly; a template renderer alone does
  not expose instructions, skills or examples to optimization.
- Delegate subject trials to experiments/ and generations to inference/.
  Reflection must not accidentally execute the subject adapter.
- Keep identity, policies, rubrics and fixture truth locked. Train supplies
  feedback; validation selects; sealed-test results cannot drive new proposals.
- Enforce a declared budget and no-improvement stop; export local candidates only.
- Test actual candidate-to-native-input propagation, locked resource mutations,
  split access and cancellation. A bridge invocation is not optimization proof.

`runner.ts` supervises the actual versioned Python bridge through the shared
`platform/process` duplex runner. `protocol.ts` validates its strict wire shapes;
`host.ts` counts actual callback attempts and checks editable components/splits.
`evidence.ts` verifies every selected candidate against complete observed validation
captures. `inference.ts` maps the exact system/user reflection pair to an explicit
tool-free inference provider; unsupported role sequences or controls fail. Models and subscription/local/API routes
are explicitly selected by the caller. Host attempt receipts never enter Python
messages: the strict wire response contains final generation metadata only. After
wire provenance verification, results gain trusted host attempt receipts; failed
optimization evidence retains classified attempt receipts too.

Consume callbacks for trials and candidate policy; never import experiments'
implementation. This module accepts no sealed-test role or data. Tests exercise
the installed Python process with a simulated host and separately test cancellation
and malformed protocol evidence. Native-agent acceptance is an integration gate.

`checkpoint.ts` journals callback reservations and completed responses using atomic
publication and directory sync. Resume verifies canonical execution identity,
callback identities and immutable generation provenance. It replays settled calls
without invoking their hosts and retains failed inference receipts. Pending calls
consume additional cumulative budget if retried. The runner supplies consumed-attempt
offsets so real GEPA stops cleanly within the remaining budget. `onRestore` exposes
sanitized accounting only. Checkpoint paths must be evaluator-owned, excluded from
subject access, and protected by the caller's exclusive output lock.

The bridge receives an owned private home, never the caller's HOME or provider
configuration. Checkpointed runs place it beside protected checkpoint files;
standalone runs use fresh temporary storage. Confirm process closure before deleting
that home; unknown closure fails and preserves it for caller cleanup. This home is
ephemeral cache state and never enters resume/checkpoint identity.

Authored `proposal` policy is forwarded unchanged to the DSPy bridge and binds the
checkpoint identity. The bridge owns train-only chronological reflection context,
lexical novelty rejection and bounded repair attempts; all generation attempts use
the same total budget. Keep full native reports/raw callbacks durable. Compact
reflection projections must retain criterion score vectors and subject usage before
bounded reasons or article excerpts. See bridges/dspy/README.md for exact defaults.

Measurement forks carry an explicit parent descriptor and byte digest into both
host and Python checkpoint owners. Each validates the old semantic request, then
publishes a new child identity with parent lineage before callbacks. Completed calls
replay exactly, pending calls preserve cumulative attempt counts, and the paired
GEPA checkpoint restores its sampler/history. Missing child journals can finish
interrupted fork initialization; missing ordinary resume journals still fail.

Protocol v2 multiplexes up to the configured concurrency. Callback IDs are reserved
before asynchronous work; native attempt capacity is reserved before validation.
Journal mutations serialize complete read/change/publish transactions. Capture
provenance compares identities independent of completion order. Drain callbacks on
shutdown; incomplete host work retains its owned home and never claims settled work.
Population mode is enabled only by `search`. It uses the same strict callbacks,
complete validation captures and selected-score verification as legacy GEPA.
The host additionally verifies per-case vectors, round lineage, declared edit scope
and Pareto/top-k retention, seed training, strategy/attempt records and stop
feasibility. Accepted components bind to host-recorded generation response text.
Behavioral/lexical heuristics are explicitly bridge-reported-v2, not independently
verified novelty evidence; do not imply host certification. Pre-round budget
feasibility does not replay the unrecorded Python parent shuffle. Search and scope bind checkpoint identity. Population
reconstructs state from settled host callbacks, with no Python pickle. Python's
`Evaluator.evaluate_many` bounds active callbacks by concurrency and preserves request-order results.
Defaults: Pareto selection, rewrite share 0.5, behavioral floor 0.08, hypothesis
similarity 0.6, patience equal to rounds, and no declared boundaries.

`boundaries.ts` validates preserve/require-text/forbid-text declarations and seed
admission before bridge launch/checkpoint restoration. The host independently checks
all candidate evaluations and returned candidates against the original seed. Unsupported
prose constraints fail closed; exact text gates do not certify semantic compliance.

Evaluation callbacks accept an optional nonnegative round from the bridge. Host
journals bind it to callback identity; training persists it before export. Old
callbacks may lack attribution; do not infer rounds from final candidate aggregates.
