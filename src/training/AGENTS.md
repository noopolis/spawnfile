# Core Source

Owns the TypeScript product modules. ESLint and per-file coverage enforce the
structure and verification rules; see the root development guide.

- Keep contracts runtime-neutral. Runtime integrations consume public interfaces;
  core rules cannot import vendor adapters or sibling implementation files.
- Use named exports and explicit module entry points. Keep tests beside source.
- Extract cohesive child modules before files approach 400 lines or folders
  become crowded; 600 lines and 30 direct files are enforced emergency gates.
- Every new implementation child needs its own focused guide and CLAUDE.md link.
- No generic helpers dump, speculative vendor stubs or empty source placeholders.
- Verify the touched module, direct dependents and ownership boundaries when
  executable code exists. Root coverage and negative-test requirements apply.
