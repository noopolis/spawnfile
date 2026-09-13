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
tool-free subscription provider; unsupported role sequences or controls fail.

Consume callbacks for trials and candidate policy; never import experiments'
implementation. This module accepts no sealed-test role or data. Tests exercise
the installed Python process with a simulated host and separately test cancellation
and malformed protocol evidence. Native-agent acceptance is an integration gate.
