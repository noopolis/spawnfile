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
binding 20:30–06:30 Europe/Berlin window. A configured `grok_window` is
intersected with that outer bound and can only narrow it.
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
context. Citation IDs must match those in the unit or its containing sentence, using the
declared row citation pattern and `leading_citations` policy. A supplied
`source_span` must occur verbatim after whitespace normalization in a cited row.
Invented spans and redirected citations are rejected and reported. Extracted
fields absent from the unit text are dropped and reported; a `when` condition on
a dropped or absent field retains a missing instance.

Extraction supplies a strict draft-07 response schema and explicitly opts Codex
and Claude into accepting exactly one surrounding `json` code fence before
provider schema validation. Other inference requests retain strict JSON behavior. Extra prose, nested
fences, duplicate keys and unknown properties fail parsing. Raw response receipts
are saved before parsing, including malformed responses and cancellation.

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

The gate requires both at least 95% **known-answer accuracy** on validated defect
traps and at least 95% **consistency** on format-paraphrase and option-permutation
controls. Controls compare variant answers to the base answer, and never count
as evidence of independent correctness. Either empty population means STOP.
Missing and uncertain answers count against their respective denominators.
Every decomposition is included in coverage: an output with no validated defect
trap is reported as uncovered, including outputs whose trap bundle is absent.
More than 10% uncovered outputs means STOP.

Instability must be at most 5%, measured only on unique base checks that went to
adjudication. Synthetic variants cannot dilute that population. Variant
adjudication is reported separately; only affected checks are evaluated for a
variant, and duplicate variant check digests count once in that diagnostic.

Number/entity, negation, citation, redundancy and formatting mutations alter output
content; evidence remains untouched. Embedded variant decompositions address the
serialized `output` payload as `embedded-output.json`; this is bundle metadata, not a separate
filesystem reference. Option permutation changes only criterion order. Independent
validation recomputes preconditions from the saved variant and source rows:

- Numbers must appear in cited evidence with formatting normalized; replacements
  preserve digit count and precision, differ by at most 20%, and occur nowhere
  in cited rows. Units remain unchanged. Unchanged option controls retain the
  legitimate base number; format controls also exercise comma normalization when
  available.
- Entity originals must occur in cited rows. Replacements come from the same
  article, have the same independently recognizable type, and are absent from
  cited rows. The current conservative recognizer supports personal honorifics
  and explicit organization suffixes; ambiguous bare names are ineligible.
- Negation requires an affirmative verbatim cited sentence counterpart and only
  inserts a negator. Existing negations or paraphrased evidence are ineligible.
- Citation swaps require a replacement row with no shared content word of four
  or more characters after stop-word removal.
- Redundancy requires changed rendered state exposing both occurrences to every
  affected check. A unit-only projection cannot observe a neighboring insertion.

Rejected mutations are counted with reasons. Validation does not regenerate
candidates. Authored answer mappings remain the contract between these mechanical
defects and each template's answer vocabulary; the checks do not prove arbitrary
semantic implications.

Each teacher/projection and adjudication call checkpoints its receipt and raw
response before decoding or propagating cancellation. Extraction does the same
for each extraction/audit phase. Resume checks content/config identity, replays
received responses, and invokes only missing or interrupted calls; completed
calls and their original accounting are retained. Malformed extraction responses
remain inspectable and fail again on resume without a duplicate provider call.
Reports and call receipts distinguish saved work from newly executed calls.
External AI reviews and weak editor verdicts use `kind: signal`; no human annotation
step participates in this pipeline. See [weak evidence provenance](graders.md#weak-evidence-provenance).
