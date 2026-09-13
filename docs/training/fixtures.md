# Named dataset fixtures

**Authoring specification draft.** This extends the [dataset proposal](authoring.md);
there is no implemented Paideia resolver. The real [training](../examples/newsroom-reporting/evals/train.yaml)
and [test](../examples/newsroom-reporting/evals/test.yaml) datasets demonstrate this surface.

## Declaration and selection

Dataset `fixtures` is an optional mapping of unique names to partial record declarations.
Each fixture may contain only `context`, `setup`, `input`, `reference` and `outputs`.
It cannot declare record identity, `group`, `checks`, `stages`, `turns` or another `use`.
Fixtures cannot inherit other fixtures. Duplicate YAML keys, including fixture names,
are errors. These declarations stay in the dataset; no additional fixture file is required.

Record `use` is an optional sequence of names from that dataset's `fixtures` mapping.
Every selected name must exist and occur only once in that record. Names are local to
the YAML file: a training record cannot resolve a fixture from the test dataset.
Defining a fixture does not select it or make its data visible to a subject.

This is the actual Kestrel record after its parameters and files move into fixtures:

```yaml
- id: kestrel-reporting
  group: kestrel-2026-09-12
  use: [afternoon-assignment, kestrel-evidence]
  input:
    prompt: |
      Report the Kestrel salvo and what the reported hardware mix establishes.
      Read the assignment and selected story packet at their usual workspace paths.
      Produce the complete publication JSON, validate it, file it under this wake,
      and notify Reviewer. Preserve source qualifications and write for readers.
```

`afternoon-assignment` supplies the existing 13:30 Berlin clock and authenticated
Chief delivery. `kestrel-evidence` supplies edition/story context, the three exact input
selectors and the evaluator-only historical article selector. The selectors and hashes
remain readable in the same YAML. Voltrail and Marovia each have their own evidence
fixture; the test file declares its own `afternoon-assignment`.

## Expansion and conflicts

Resolve declarations before preparation, inference or other paid work:

1. Validate fixture fields and unique names, then resolve each record's `use` sequence.
   Reject unknown or repeated references.
2. Merge the selected fixtures. Maps merge recursively. Arrays and scalars are atomic
   values: never append arrays or merge their elements by position or identity.
3. If two selected fixtures supply unequal values at the same path, fail before applying
   record-local values. Identical values are allowed. Map key order is irrelevant;
   array order and scalar types matter. A map versus a scalar/array also conflicts.
   Changing `use` order or adding a local override cannot hide a fixture conflict.
4. Overlay the record's explicitly authored values on the merged fixture values.
   Maps merge recursively; a local array or scalar replaces the whole corresponding
   value. Overrides must be allowed by the field schema and unlocked parameter policy.
   The record keeps its local `id`, `group` and any additional checks allowed by the
   [record schema](authoring.md#dataset-and-record-fields); fixtures supply none of these.
5. Apply the dataset's root `setup` as defaults beneath the expanded record's setup.
   Resolve typed context bindings and validate the complete effective record and setup.
   Record the expanded content and selected fixture provenance in the run manifest.

Bindings can use values supplied by another selected fixture: `afternoon-assignment`
resolves its clock date from the evidence fixture's `context.edition` after merging.

For example, a local `input.files` replaces a fixture's complete file list; it does
not append one file. Two selected fixtures with different `input.files` lists conflict,
even if a local list would replace both. Partially overlapping maps are allowed only
when every overlapping value agrees.

Dataset `setup` remains the recipe selector and shared defaults; there is no `defaults`
wrapper. Fixture/record setup can fill or override only parameters explicitly declared
unlocked by that recipe and the invocation. It cannot replace `setup.profile`, change
locked native configuration or weaken isolation, access policy or mandatory criteria.
Root setup values that differ from allowed record parameters are defaults, not a
conflict between two selected fixtures. Validate the final result against locked policy
before preparation; a local overlay cannot evade that validation.

## State, visibility and dataset roles

Expansion creates independent values for each record. Mutating one expanded record
must not alter its fixture declaration or any other record. A fixture is a declaration,
not a shared workspace, memory store, conversation or live service. Every independent
record/repetition still receives fresh trial state.

Visibility follows the expanded field: `input` is subject-visible, `reference` stays
evaluator-only and `context` is not automatically sent to the subject. Selected fixture
names grant no additional access. Dataset criteria always apply unchanged.

After expansion, perform all existing source/hash, evidence-family, overlap and split
checks on the effective records. Reusing a packet cannot hide repeated evidence behind
different fixture or record names. Training/validation views must exclude sealed-test
inputs and references regardless of whether selectors were authored locally or in a
fixture. Expansion does not relax the [source isolation rules](authoring.md#environment-fidelity-and-emulation).
