# Experiment Lifecycle

Owns isolated trial lifecycle, budgets, cancellation and phase access.

- Compose public case, candidate, subject, evaluation and storage interfaces.
  Do not implement the agent's cognitive loop or production organization strategy.
- Reset frozen workspace, evidence, tool and memory fixtures for each attempt.
  Keep authoritative records and labels outside subject-writable state.
- Enforce explicit train/validation/sealed-test access; preserve repetition IDs.
- Account for subject, optimizer, judge and embedding work separately. Terminal
  usage cannot be advertised as an exact live spending ceiling.
- A launched process or exit zero is insufficient: require observable completion
  and artifacts. Cancellation must reach owned work and report incomplete evidence.
- Test failed preparation, partial capture, timeout, cancellation and cleanup as
  well as successful isolated trials. Never use mutable production fixtures.
