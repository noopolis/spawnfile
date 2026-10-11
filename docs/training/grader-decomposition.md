# Atomic checks and agent references

The decomposition pipeline is separate from legacy golden-label calibration.
Question wording, unit kinds, dimensions, criteria and trap answer mappings belong
in operator-authored templates. The core contains no domain-specific questions.
Generated files remain local. These interfaces have automated tests; native council
quality still requires a real corpus run and the reference gate.

## Authoring templates

```yaml
schema: paideia.check-templates.v1
teachers:
  - { id: codex, provider: codex, model: YOUR_CODEX_MODEL }
  - { id: claude, provider: claude, model: YOUR_CLAUDE_MODEL }
context:
  evidence:
    rows:
      heading: '^## ([a-z0-9-]+)'
      cite: '\[([a-z0-9-]+)\]'
  assignment: { role: assignment }
templates:
  - id: supported
    applies_to: claim
    type: choice
    instructions: 'Is {unit.text} supported by the cited evidence?'
    criteria:
      supported: The evidence supports the proposition and its qualifiers.
      unsupported: The evidence does not support the proposition.
    expected: [supported]
    state: [unit, unit.cited_rows]
    dimension: grounding
    severity: critical
    traps:
      number-substitution: unsupported
      entity-substitution: unsupported
      negation-flip: unsupported
      citation-swap: unsupported
      format-paraphrase: unchanged
      option-permutation: unchanged
```

Choose installed subscription model identifiers explicitly. Teacher identifiers in
CLI flags select these declarations. Grok is optional and runs only inside the
configured `grok_window`, default `{start: '20:30', end: '06:30'}` in Europe/Berlin.
The end boundary is exclusive. No API-key fallback is available.

Criteria are answer-to-description maps. Noul uses quoted `"true"` and `"false"`
keys; score uses quoted integer keys with descriptions. `expected` lists good answers. State reads
are `unit`, `unit.cited_rows`, `output.<path>`, `context.<name>`, `paragraph`, and
`neighbors`. Paragraph and sentence addresses are zero-based. A template can add
`when: {field: modality, equals: required}`. Missing state produces a missing
instance rather than silently removing a check.

Trap mappings are explicit because arbitrary operator-authored questions cannot
safely be assigned an intended answer from their wording. Only mapped templates
participate in each trap. Format and option controls compare with the original
reference; they do not assume the original output is correct.

## Inputs and commands

Use the existing input manifest shape, with paths relative to the manifest:

```yaml
schema: paideia.grader-inputs.v1
items:
  - id: output-1
    lineage: source-family-1
    output: { from: output.json }
    context:
      evidence: { from: evidence.md }
      assignment: { from: assignment.md }
```

With those operator-authored files prepared, run from a fresh checkout:

```sh
npm ci
npm run build
node dist/src/cli/main.js grader decompose --templates templates.yaml --inputs inputs.yaml --extractors codex,claude --out local/decompositions
node dist/src/cli/main.js grader traps --templates templates.yaml --decompositions local/decompositions --out local/traps
node dist/src/cli/main.js grader reference --templates templates.yaml --decompositions local/decompositions --traps local/traps --teachers codex,claude --out local/references.json --concurrency 2 --timeout-ms 3600000
```

Extraction returns units; a fresh second extraction call audits omissions. With
one selected extractor, the second call uses the same provider in a fresh session.
Use two providers for vendor independence. Output/context byte hashes bind the
saved decomposition to its inputs. Text must occur within an output string after
whitespace normalization. Obligation units may instead quote declared assignment
context. Invented spans and unknown cited rows are rejected and reported.

Instantiation is deterministic. IDs are `<template>@<unit>` and digests include
the rendered question and projection. Teachers see only declared state; identical
projections share a batch. All teachers answer before any sees peer answers.

## Reference interpretation

Responses are strict objects keyed by check ID, with `answer`, optional `p`, and
optional verbatim evidence `span`. Teachers may abstain. Probability `p` contributes
that much mass to the selected answer; unassigned mass stays explicitly unknown.
Missing and abstaining teachers retain their share of the denominator.

Disagreement or abstention triggers one adversarial adjudication round for the
output. Teacher identities are hidden and competing answers are seeded-shuffled.
A second fresh call with reversed order measures instability. Differing outcomes
or unresolved answers remain uncertain. The references file retains independent
answers, both adjudications, distributions, call usage/latency and content identity.
Teacher agreement is also measured against peers with the evaluated teacher
excluded; it is not an independent claim of correctness.

The gate requires at least 95% trap accuracy and at most 5% adjudication instability.
Missing and uncertain trap answers count against accuracy. No validated traps means
STOP. Reports identify failed trap kinds and templates and report option-permutation
consistency. Passing synthetic controls does not establish general factual truth.

Number/entity, negation, citation, redundancy and formatting mutations alter output
content; evidence remains untouched. Embedded variant decompositions address the
serialized `output` payload as `embedded-output.json`; this is bundle metadata, not a separate
filesystem reference. Option permutation changes only criterion order. Independent
code validation checks the applied mutation and substitution
absence from cited rows. It cannot prove arbitrary semantic implications; authored
trap mappings remain part of the operator's evaluation contract.

Completed outputs checkpoint locally and resume only with matching content/config
identity. Reports and call receipts distinguish saved work from newly executed calls.
External AI reviews and weak editor verdicts use `kind: signal`; no human annotation
step participates in this pipeline. See [weak evidence provenance](graders.md#weak-evidence-provenance).
