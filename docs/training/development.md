# Development and growth

This specifies the intended toolchain and maintenance workflow. No ESLint config,
coverage runner, product implementation or website build exists yet. These
requirements are not automatically enforced today.

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
| Future product documentation site | website/ |
| Architecture and contributor guidance | docs/ |

Create adapter folders for actual implementations, not anticipated vendors.
Extract shared modules for real shared responsibilities; avoid miscellaneous
utils/ or helpers/ collections.

## Planned lint and coverage gates

The future ESLint setup must warn above 400 lines and fail above 600 lines for
maintained source, tests and configuration. Split before 400 in ordinary work.
The ceiling protects against unchecked growth, not a justification for a mixed
590-line file. Count comments and blanks; never compress code to evade limits.

The planned budget is 30 direct maintained files per directory. Dependencies and
generated output are outside maintained-source counts. Split earlier when
responsibilities diverge or navigation becomes difficult. Recursively check new
implementation folders for focused AGENTS.md and CLAUDE.md symlink pairs; moving
files into a deeper unchecked folder must not bypass enforcement.

Coverage must reach 90% for statements, branches, functions and lines, globally
and per executable TypeScript file. Include source no test imported. Tool config
and type-only declarations need an explicit scope policy; broad exclusions cannot
hide executable behavior. Tests are not product coverage targets. The Python
bridge needs language-appropriate tests and coverage when introduced.

Test observable success, failure, missing evidence and cancellation where relevant.
Delete or corrupt the property behind a guarantee and verify an actual test fails.
Checking that a rule is mentioned in configuration does not prove enforcement.
No gates exist yet, so add runnable validation commands with the real toolchain.

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
