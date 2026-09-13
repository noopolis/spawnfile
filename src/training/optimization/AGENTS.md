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
