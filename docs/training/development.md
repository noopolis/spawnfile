# Development and growth

The TypeScript toolchain now enforces the repository's structural and coverage
rules. CI runs the same gates from a clean install, plus the locked Python bridge
tests. Native subscription probes remain local; there is no publishing workflow.

```sh
npm ci
uv venv --python 3.14 bridges/dspy/.venv
uv pip install --python bridges/dspy/.venv/bin/python -r bridges/dspy/requirements.lock
uv pip install --python bridges/dspy/.venv/bin/python --no-deps -e bridges/dspy
npm run check
```

The full TypeScript suite includes real DSPy integration tests, so it requires
the bridge environment. Core package installation itself has no Python or Daimon
dependency. CI creates the same venv using the selected Python and pip.

## Place work with its owner

| Work | Location |
|---|---|
| Neutral types and public interfaces | src/contracts/ |
| Feature and unit tests | Owning src/ module, beside each other |
| Runtime integration and conformance tests | Cohesive child of src/adapters/ when implemented |
| Evaluator and edge-case fixtures | Its evaluation family, beside the code |
| Generic YAML tasks, rubrics and frozen data | Named suites under evals/ |
| Private datasets, credentials or captured runs | Local/private storage outside tracked suites |
| Narrow Python interoperability | bridges/dspy/ |
| Local live/replay UI | viewer/ |
| Local product documentation site | website/ |
| Architecture and contributor guidance | docs/ |

Create adapter folders for actual implementations, not anticipated vendors.
Extract shared modules for real shared responsibilities; avoid miscellaneous
utils/ or helpers/ collections.

## Installed lint and coverage gates

ESLint warns above 400 lines and fails above 600 lines for
maintained source, tests and configuration. Split before 400 in ordinary work.
The ceiling protects against unchecked growth, not a justification for a mixed
590-line file. Count comments and blanks; never compress code to evade limits.

The budget is 30 direct maintained files in each directory under src/, viewer/
and tooling/. Files and symlinks count; subdirectories and .DS_Store do not.
Dependencies and generated output are outside the lint scope. Every implementation
directory and its ancestors within that managed root need a nonempty AGENTS.md
and a CLAUDE.md symlink to
that same local file. New nested directories enter the checks automatically.

Cross-owner modules and nested sibling modules import public index files.
Nested indexes are explicit public seams too, such as platform/process/index.ts;
an internal-only directory must not expose an index as if it were public.
The contracts/*.ts files are explicit public type seams. Same-owner directory
and ancestor helpers remain private implementation details. Relative, absolute
and file-URL imports cannot escape the repository, including through symlinks.
Computed imports require a statically known literal or const literal binding.
Package subpath aliases are rejected; tsconfig path aliases are not part of this
repository's module design. TypeScript import-equals and path references enter
the same boundary checks as imports and re-exports.
The neutral core cannot import native integrations or experiment lifecycle;
the optional Daimon public package belongs only to its adapter.

Coverage must reach 90% for statements, branches, functions and lines, globally
and per executable TypeScript file. Include source no test imported. Tool config
and type-only declarations need an explicit scope policy; broad exclusions cannot
hide executable behavior. Tests are not product coverage targets. The Python
bridge needs language-appropriate tests and coverage when introduced.

Test observable success, failure, missing evidence and cancellation where relevant.
Delete or corrupt the property behind a guarantee and verify an actual test fails.
Checking that a rule is mentioned in configuration does not prove enforcement.
The structural tests invoke the actual ESLint configuration against temporary
violations: 401/601 lines, missing or redirected guides, a 31st file, forbidden
JavaScript and imports crossing implementation or repository boundaries.

## Repair growth without changing behavior

1. Name the owner and trigger: size, crowding, mixed responsibility, dependency
   violation, missing guide or failed check. Define the observable success.
2. Extract a cohesive module with a small public interface, preserving contracts.
   Numbered chunks and miscellaneous utility dumps are not repairs.
3. Move tests and private fixtures with the code. Update imports, named exports,
   local guides and nearby docs together.
4. Run affected tests, direct dependents and named failing checks. Mutation-test
   changes to enforcement. Full suites and applicable builds belong at the final
   review/commit boundary.
5. Verify outputs and checks actually ran. Use independent cross-vendor review
   at the final gate; report unavailable validation explicitly.

Set success, at most three local fix/review rounds and an impasse condition before
iterating. If a defect survives, reassess the owning layer. If it cannot be fixed
correctly, say so. Never reset the count, relocate the defect or expand scope just
to consume optional advice.

Behavior-preserving extraction is authorized maintenance. Changes to ownership,
public architecture, case semantics or optimization policy require discussion.
Never lower coverage, relax rubrics, rewrite dataset splits, change production
agents or deploy software as an automatic response to a red check.

## Guidance that stays useful

A nested AGENTS.md names ownership, public interfaces, prohibited behavior and
meaningful verification. Its CLAUDE.md is a relative symlink to that same file.
Inherit common policy instead of copying the root guide everywhere. When files
move, update both affected local guides and remove obsolete instructions.

Keep status honest: proposal, implemented, tested and deployed are different
states. Documentation accompanies implementation. Derive working commands and
examples from tests once contracts exist; do not invent runnable YAML first.
