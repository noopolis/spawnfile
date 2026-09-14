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
