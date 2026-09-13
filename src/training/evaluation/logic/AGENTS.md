# Logical Composition

Owns logical nodes, dependencies, conditions, thresholds, gates and scores.

- Remain pure over typed results; no provider calls, runtime SDKs or filesystem I/O.
- Preserve unknown/error/skipped evidence when another result decides a composite.
  Negating unknown cannot produce pass; an unknown condition cannot evade a gate.
- Keep declared score denominators and report observed/missing weight. Required
  gates and required coverage are independent of the weighted average.
- Validate references, cycles, weights and score ranges before reporting success.
- Test truth tables, missing coverage and skipped branches. Mutation checks must
  catch denominator inflation and accidental conversion of unknown to pass.
