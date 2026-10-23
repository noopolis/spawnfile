# Training Core

This is Spawnfile’s runtime-neutral training core; must not import
../runtime, ../compiler. Its structural rules run through Vitest and its imported
per-file coverage floor remains 90%. Runtime adapters live under their runtime owners and enter through subjects/registry.ts.

The child folders own contracts, cases, evaluation, optimization, experiments,
providers, storage, CLI orchestration, the viewer, and the DSPy Python bridge.

- Keep contracts runtime-neutral. Runtime integrations consume public interfaces;
  core rules cannot import vendor adapters or sibling implementation files.
- Use named exports and explicit module entry points. Keep tests beside source.
- Extract cohesive child modules before files approach 400 lines or folders
  become crowded; 600 lines and 30 direct files are enforced emergency gates.
- Every new implementation child needs its own focused guide and CLAUDE.md link.
- No generic helpers dump, speculative vendor stubs or empty source placeholders.
- Verify the touched module, direct dependents and ownership boundaries when
  executable code exists. Root coverage and negative-test requirements apply.

`providers/` supplies neutral built-ins; `contracts/inference-registry.ts` defines injected validation, identity, admission and factory descriptors. CLI dependencies carry the same registry through parsing, defaults, cache identities and execution. Factories own command-local resources with awaited cleanup. Non-test files must contain no engine names, including fixtures and documentation. Historical provider fixtures live outside this core.

Runtime integrations may consume contracts and the public root barrel only. Its process, schema, diagnostic, capture and path-protection helpers are deliberate public services. Grader registration is immutable process composition: install once before authored schema parsing; reject replacement, create fresh providers per operation.
