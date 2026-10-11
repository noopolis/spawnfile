# Atomic checks and agent references

The decomposition pipeline is separate from legacy golden-label calibration.
Question wording, unit kinds, dimensions, criteria and trap answer mappings belong
in operator-authored templates. The core contains no domain-specific questions.
Generated files remain local. These interfaces have automated tests; native council
quality still requires a real corpus run and the reference gate.

## Authoring templates

```yaml
schema: paideia.check-templates.v1
kinds:
  claim: A verbatim factual proposition, preserving qualifiers.
  display: A headline, deck or kicker span.
teachers:
  - { id: codex, provider: codex, model: YOUR_CODEX_MODEL }
  - { id: claude, provider: claude, model: YOUR_CLAUDE_MODEL }
context:
  evidence:
    rows:
      heading: '^## ([a-z0-9-]+)'
      cite: '\[([a-z0-9-]+)\]'
      leading_citations: previous
  assignment: { role: assignment }
templates:
  - id: supported
    applies_to: claim
    locations: [body]
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
      number-substitution: { answer: unsupported, known_answer: false }
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

Criteria are answer-to-description maps. The labels `missing`, `abstain`,
`uncertain` and `unchanged` are reserved and rejected as criteria keys. Noul uses quoted `"true"` and `"false"`
keys; score uses quoted integer keys with descriptions. `expected` lists good answers. State reads
are `unit`, `unit.cited_rows`, `output.<path>`, `context.<name>`, `paragraph`, and
`neighbors`. Paragraph and sentence addresses are zero-based. A template can add
`when: {field: modality, equals: required}`. Missing state produces a missing
instance rather than silently removing a check.

Optional top-level `kinds` maps kind names to descriptions passed to both extractor
calls. Kinds referenced by `applies_to` remain valid without descriptions. Optional
per-template `locations` restricts matching kinds to declared output fields;
omission means every location. Excluded template/unit pairs appear in
`instantiateChecksReport(...).skipped` and the local `<id>.instantiation.json`
artifact written by `grader decompose`. Invalid spans remain missing checks, even
with a location restriction; they cannot use a hint to bypass validation.

Trap mappings are explicit because arbitrary operator-authored questions cannot
safely be assigned an intended answer from their wording. Only mapped templates
participate in each trap. A shorthand label declares a known-answer mapping, as
before; the explicit form is `{ answer: <label>, known_answer: true|false }`.
`known_answer: false` declares a **DIAGNOSTIC** mapping. These traps are generated,
validated and run normally, and their accuracy is reported separately by kind and
template. They never contribute to known-answer accuracy, group floors, consistency
gates or output coverage. Status belongs to each template/kind mapping, so two
templates may classify the same mutation differently.

Number substitution's answer depends on quantity semantics that lexical validation
cannot establish. Declare it diagnostic unless the operator has a semantic
validator. For example, changing 10 to 11 in “10 dollars or less” or “a sum not
exceeding 10 dollars” can remain entailed by evidence of exactly 10 dollars.
The built-in validator does not certify a known answer for these quantities;
`known_answer: true` is an operator declaration, not a code guarantee.

Format and option controls compare with the original
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
node dist/src/cli/main.js grader reference --templates templates.yaml --decompositions local/decompositions --teachers codex,claude --out local/base.json --timeout-ms 3600000
node dist/src/cli/main.js grader traps --templates templates.yaml --decompositions local/decompositions --references local/base.json --out local/traps
node dist/src/cli/main.js grader reference --templates templates.yaml --decompositions local/decompositions --traps local/traps --teachers codex,claude --out local/references.json --concurrency 2 --batch-size 40 --timeout-ms 3600000
```

The base-only reference command deliberately returns STOP (exit 1): accuracy and
consistency are unmeasured until traps exist. Its completed council finals are
still persisted. `traps --references FILE` verifies that artifact's digest,
templates and decomposition identities. Defects require every affected base final
to belong to its template's `expected` answers. Without `--references`, only
consistency controls can be generated. The final reference run also checks base
eligibility before dispatching a defect variant.

Extraction and omission-audit prompts share an extraction-only template view with
checkpoint identity: kind descriptions, per-template `applies_to`, `locations`,
`when.field` (without comparison values), and context rows/roles. Grading answers,
criteria, traps, dimensions, severities and instructions are excluded. Editing only
those grading fields reuses extractions; extraction declaration changes invalidate
them. Instantiation reports are regenerated using the current full templates.

Extraction returns units; a fresh second extraction call audits omissions. With
one selected extractor, the second call uses the same provider in a fresh session.
Use two providers for vendor independence. Output/context byte hashes bind the
saved decomposition to its inputs. Text must occur within an output string after
whitespace normalization. Obligation units may instead quote declared assignment
context. Validation searches output string fields itself and derives `location`
(`body`, `headline`, `deck`, `kicker`, or a dotted nested field path). Assignment
spans use `context.<name>` paths. A unique occurrence overrides extractor location,
paragraph and sentence hints; multiple occurrences require hints consistent with
exactly one match. Zero matches and unresolved ambiguity are rejected.
The CLI assigns `x1`, `x2`, … to extraction units and `a1`, `a2`, … to audit units
in response order, retaining each extractor ID as `label`. Audit units matching an
existing unit's kind, whitespace-normalized text and resolved occurrence (location,
paragraph, sentence and raw source character offset) are dropped. Identical text
at a different occurrence is retained; unresolved spans still reach validation. Checkpoint
`duplicates` records their IDs, labels, matching IDs and reasons, and the command
summary reports their count. Repeats within the audit response are also dropped.
Extraction protocol v8 rejects earlier checkpoints; regenerate in a fresh directory.
The decomposition persists each rejected unit with its text and rejection reasons.
Both `traps` and `reference` refuse these artifacts unless `--allow-rejections`
is explicit. With that flag, each rejected unit remains one missing check in the
instantiation artifact, coverage and reference report, and the gate remains STOP.

Body addresses use the grading runtime's English `Intl.Segmenter` and the shared
row citation policy. `leading_citations: previous` moves a leading citation run to
the preceding sentence in the same paragraph; the default `keep` retains it.
`cites` derives from that runtime sentence, regardless of extractor-supplied cites.
A span crossing ICU sentence boundaries starts at the first touched sentence and
collects citations from all touched sentences (for example, an abbreviation split).
Non-body spans have no paragraph/sentence address and no cites. Supplied citation
disagreements are recorded in checkpoint `citationDisagreements`; omitted cites
are simply derived. Unknown derived row IDs still fail validation. A supplied
`source_span` must occur verbatim after whitespace normalization in a derived cited
row. Invalid optional source spans are dropped and reported without rejecting an
otherwise valid unit; dropped hints never enter council evidence. Omit the hint
when no supporting quote exists. The new extraction protocol refuses earlier checkpoints as stale; use a fresh
output directory when regenerating an older extraction. Extracted
fields absent from the unit text are dropped and reported; a `when` condition on
a dropped or absent field retains a missing instance.

Extraction supplies a strict draft-07 response schema and explicitly opts Codex
and Claude into accepting exactly one surrounding `json` code fence before
provider schema validation. Other inference requests retain strict JSON behavior. Extra prose, nested
fences, duplicate keys and unknown properties fail parsing. Raw response receipts
are saved before parsing, including malformed responses and cancellation. Native
provider schema rejections retain the typed failure class and any protected
provider diagnostic in the local mode-0600 checkpoint. Diagnostic response text
is available only when the provider supplies it; no text is invented for providers
that omit it. Malformed responses are retried on resume rather than replayed.

Instantiation is deterministic. IDs are `<template>@<unit>` and digests include
the rendered question and projection. Council calls batch ready checks from one
output in instance order, up to `--batch-size N` (default 40, positive integer).
Each question carries its own `evidence` containing exactly its rendered projection;
there is no shared projection. Thus 100 ready checks require three independent
calls per teacher at the default size, even with 100 different projections.
Teachers run concurrently, with one call in flight per teacher for that output.
`--concurrency` still bounds output workers (default 2), so several outputs may
use the same teacher concurrently. Independent calls never contain peer answers;
adjudication waits for every teacher's queue to finish. Each adjudication pass
uses the same batch-size bound.

## Reference interpretation

Responses are strict objects keyed by check ID, with `answer`, optional `p`, and
optional verbatim evidence `span`. Teachers may abstain. Probability `p` contributes
that much mass to the selected answer; unassigned mass stays explicitly unknown.
Missing and abstaining teachers retain their share of the denominator. Persisted
non-answers use `answer: null` with a typed `status` (`missing`, `abstain` or
`uncertain`), so provider failures cannot collide with an authored answer label.
An agreed final requires real, positive-confidence teacher answers; adjudication
cannot supply missing independent support. Council protocol v4 invalidates older
checkpoints; regenerate them in a fresh destination. Batch size also enters checkpoint
identity, so changing it requires a fresh destination.

Disagreement or abstention triggers one adversarial adjudication round for the
output. The default adjudicator is selected from the active teachers after window
filtering. An adjudicated final needs positive-confidence support from at least
one other teacher's independent answer. Teacher identities and probabilities are
removed from competing answers; verbatim evidence spans remain. A random per-run
secret shuffles peers and is persisted only in run state, never model prompts.
The second fresh call reverses even panels and rotates odd panels so every
position moves. Differing outcomes
or unresolved answers remain uncertain. The references file retains independent
answers, both adjudications, distributions, call usage/latency and content identity.
Teacher agreement is also measured against peers with the evaluated teacher
excluded; it is not an independent claim of correctness.

The gate requires both at least 95% **known-answer accuracy** on operator-declared known-answer, validated defect
traps and at least 95% **consistency** on format-paraphrase and option-permutation
controls. Controls compare variant answers to the base answer, and never count
as evidence of independent correctness. Either empty population means STOP.
Missing and uncertain answers count against their respective denominators.
Defect credit requires the intended final answer AND a change from the base final;
a constant label cannot earn known-answer credit. Known-answer groups by kind
and template independently require 95% accuracy when they contain at least ten
traps. Smaller groups are reported as insufficient; pooled gates still apply.
Control groups are reported separately as CONSISTENCY, never pooled into accuracy.
Every decomposition is included in coverage: an output with no validated known-answer defect
trap is reported as uncovered, including outputs whose trap bundle is absent.
Diagnostic-only outputs are uncovered. Any uncovered output means STOP.

Completeness separately requires **missing base checks <= 0%**. Every unique
instantiated base check participates: missing placeholders, state or condition
fields, rejected-unit checks, and any null council final count as missing.
Any missing check means STOP, even with perfect traps and controls elsewhere in
the same output. JSON and Markdown reports include counts by template and output;
rejected-unit accounting remains separately visible. Variants never enter this
base completeness denominator.

Instability must be at most 5%, with all unique ready base checks in the
denominator. Agreed checks count as stable; any uncertain adjudication counts as
unstable, including two identical uncertain answers. Missing-state checks stay
outside this ready-check denominator. Synthetic variants cannot dilute that population. Variant
adjudication is reported separately; only affected checks are evaluated for a
variant, and duplicate variant check digests count once in that diagnostic.

### Known limits of lexically validated traps

Independent validation proves that the mutation happened and its lexical
preconditions hold; it cannot prove non-entailment. An operator-declared
known-answer label can therefore still be wrong:

- **Citation swap:** a replacement row can paraphrase the claim without sharing
  a content word. “The physician resigned” remains supported by “The doctor quit.”
- **Negation:** inserting a negator inside an uncertainty frame need not change
  support. “Whether Dr. Vale is paid remains unknown” and “Whether Dr. Vale is not
  paid remains unknown” can both be supported by the same uncertainty. A cited
  row can also contain both the affirmative sentence and its negated counterpart;
  finding the affirmative counterpart does not rule out support for the mutation.
- **Entity substitution:** universally quantified evidence can support a person
  absent from the row. “Every person is paid ten dollars; Dr. Vale is a person”
  can still support “Dr. Reed is paid ten dollars” after replacing Dr. Vale.
- **Number substitution:** bounds or comparisons can preserve support despite a
  changed number. Evidence of exactly 10 dollars supports both “a sum not
  exceeding 10 dollars” and “a sum not exceeding 11 dollars.” Operators should
  declare number substitution `known_answer: false`.

The 95% thresholds absorb a small label-noise rate, so a gate result is a
statistical signal, not a proof. Operators should keep only trap kinds whose
failure modes are rare in their corpus and report diagnostic kinds separately.

Number/entity, negation, citation, redundancy and formatting mutations alter output
content; evidence remains untouched. Embedded variant decompositions address the
serialized `output` payload as `embedded-output.json`; this is bundle metadata, not a separate
filesystem reference. Option permutation changes only criterion order. Independent
validation recomputes preconditions from the saved variant and source rows:

- Numbers are extracted from citation-free claim text and heading-free evidence;
  mutations preserve citation tokens. Numbers must appear in cited evidence with formatting normalized; replacements
  preserve digit count and precision, differ by at most 20%, and occur nowhere
  in cited rows. Every occurrence of the selected numeric value is replaced,
  including equivalent comma formatting, while citation tokens are preserved.
  The existing whole-unit lexical eligibility rule reduces bad diagnostics; it
  does not guarantee exact quantities or non-entailment. The
  entire unit text (including citation text) and every claim field must contain no
  bound, approximation or comparison vocabulary: at most, at least, up to, more
  than, less than, fewer, over, under, above, below, about, around, roughly, nearly,
  almost, approximately, some, or so, plus, minimum, maximum, ~, >, <, ≥ or ≤.
  They must also contain no range construction: between … and, from … to, or a
  dash or “to” between numbers, including intervening currency/unit words.
  Qualifiers on other quantities also exclude the whole unit. Construction and
  independent validation recompute the same eligibility rule.
  Measurement units remain unchanged. Unchanged option controls retain the
  legitimate base number; format controls also exercise comma normalization when
  available.
- Entity originals must occur in cited rows. Replacements come from the same
  article, have the same independently recognizable type, and are absent from
  cited rows. The current conservative recognizer supports personal honorifics
  and explicit organization suffixes; ambiguous bare names are ineligible.
  Honorific/legal-suffix variants, shared head tokens and contained names are
  rejected as potentially co-referent. Every occurrence of the selected entity is
  replaced. Both substitution kinds update extracted fields consistently and
  independently reject variants retaining the original value in claim text
  (excluding citation tokens).
- Negation requires an affirmative verbatim cited sentence counterpart and only
  inserts a negator. Exactly one auxiliary is required, with no preceding
  who/which/that/when/because/although/if marker. Has/have/had require a recognized
  past participle. Existing negations, ambiguous clauses and paraphrased evidence
  are ineligible; this is a conservative surface check, not a full grammar parser.
- Citation swaps require exactly one cited row and one citation token, plus a replacement row with no shared content word of four
  or more characters after stop-word removal.
- Redundancy requires changed rendered state exposing both occurrences to every
  affected check. A unit-only projection cannot observe a neighboring insertion.

Rejected mutations are counted with reasons. Validation does not regenerate
candidates. Authored answer mappings remain the contract between these mechanical
defects and each template's answer vocabulary; the checks do not prove arbitrary
semantic implications.

Each teacher batch and adjudication call checkpoints its receipt and raw
response before decoding or propagating cancellation. Extraction does the same
for each extraction/audit phase. Resume checks content/config identity, replays
received responses. In incomplete council checkpoints, generation-error and
invalid-response calls are retried; only complete checkpoints are reused as-is.
Resolved active teachers and the current window state are part of council identity;
a changed window refuses resume and requires a fresh run destination. Extraction
retries malformed responses and provider schema failures, retaining earlier receipts.
Checkpoint writes are serialized immutable snapshots so concurrent teacher completions
cannot overwrite a newer receipt with an older snapshot. Started queues drain before
failure is returned; a failed checkpoint write stops further batches.
The legacy aggregate calls/latency line excludes cancelled receipts. Per-teacher
accounting includes all retained calls (independent, adjudication, failed and cancelled),
input/output token totals and summed call wall time. Missing tokens are explicitly
counted as unknown; cached-input tokens are subsets, not added again. Reused calls
retain their original receipts and are not counted twice. Summed call wall time is
provider-call duration, not elapsed command time when output workers overlap.
External AI reviews and weak editor verdicts use `kind: signal`; no human annotation
step participates in this pipeline. See [weak evidence provenance](graders.md#weak-evidence-provenance).
