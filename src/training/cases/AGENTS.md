# Case Resolution

Owns strict YAML parsing, same-file fixture expansion, normalized evaluation plans,
trusted multi-turn binding declarations and dataset role validation. Execution,
evidence collection and actual evaluator behavior belong to their own modules.

Public entry point: `index.ts`. Shared data types live in `../contracts/dataset.ts`.
`parseDatasetYaml` preserves source identity and locations; `resolveDataset` expands
and validates the complete effective records before any native work starts.

- Unknown fields, duplicate YAML keys, aliases, traversing paths, malformed hashes,
  fixture conflicts, unsupported registries and unresolved dependencies fail closed.
  A source selector's hash is syntax-checked here; the preparer authenticates bytes.
- Fixture maps merge recursively; conflicting atomic values fail before local overlays.
  Arrays replace atomically. Recipe and invocation must both unlock setup changes.
  Expanded records are independent values; references never become subject input.
  `{context: name}` is reserved in value slots. Named field/artifact containers are
  maps, not expressions; output names such as `context` remain literal names.
  `{binding: name.path}` is reserved for later-turn inputs only, never setup,
  criteria, context or evaluator references.
- Built-in evaluator descriptors own parameter validation only. Runtime implementations
  consume these same descriptors. Project evaluator/recipe registrations must validate
  every supplied parameter and explicitly declare version and supported controls.
- Rulesets expand before semantic/mechanical eligibility. Live result references are
  forbidden; semantic/embedding dependencies cannot acquire stop or turn-gate authority.
  Registered stop eligibility is not proof of a particular runtime failure's finality.
- Criterion sidecars require protected bytes, authenticated into the shared plan digest.
  Inline JSON schemas and the exact copied sidecar bytes are compiled before native
  construction. The shared compiler retains Ajv strict checks except strictRequired;
  required-only properties remain valid and required fields remain enforced. Evaluation
  uses this same versioned policy; never silently reinterpret historical reports.
  Native binding declarations select trusted observations; only later turn inputs may
  reference them. Binding values/cardinality are verified by experiments at runtime.
  Each turn has its own check-ID namespace; reports must keep the turn identity.
  Reusing a check ID in another turn or in terminal checks does not alias its result.
- Split checks require groups and prevent shared source paths/content hashes across
  train, validation and test. Filesystem derivative filtering remains with preparation.
- Tests live beside implementation. Real newsroom examples are read unchanged using
  schema-only test registrations; this is not a claim of a working newsroom adapter.

Run targeted tests and coverage for `src/cases` during edits, plus TypeScript and ESLint.
Keep every executable file above the inherited 90% coverage thresholds. Every claimed
rejection needs an adversarial case; a registry stub must never imply native support.
