# Fixed questions and deterministic text checks

Use the existing `paideia.grader.v1` format when humans have already written the
questions. It expands fixed questions, binds only declared reads, and sends them
to the existing decision backend. There is no decomposition or LLM extraction.
`llm-rubric` remains the separate free-form semantic evaluator. See the complete
[three-family dataset](../examples/fixed-questions/evals/delivery.paideia.yaml)
and [six-question grader](../examples/fixed-questions/evals/item.grader.yaml).

## Explicit identity calibration

```yaml
schema: paideia.grader.v1
id: fixed-reader
calibration: identity
context:
  grounding: { description: Frozen human-authored facts }
model: { backend: typesafe, name: jev-1.13.0 }
max_spend_usd: 0.50
questions:
  - id: quantity
    ask: Does the article tell the reader there are ten items?
    type: yes-no
    expected: 'yes'
    weight: 2
    reads: [context.grounding, output.body]
  - id: arrived
    ask: Does the article claim the delivery has already arrived?
    type: yes-no
    expected: 'no'
    reads: [context.grounding, output.body]
score: { method: weighted, pass_at: 0.8 }
```

`calibration: identity` is a reserved explicit mode, not a filename. It needs no
labeled examples, calibration JSON, golden declaration, teachers or escalation.
Only one `model` is supported in this mode; named `models`, teacher backends,
nonempty golden labels and teacher fallback/escalation are refused. Local decision
backends are also supported. TypeSafe requires an explicit `max_spend_usd`, including
zero to prohibit dispatch. Existing transport admission, shared command budgets,
retry accounting and sanitized paid failure receipts apply unchanged.

Broker-capped native training admits identity-mode TypeSafe graders only with an
explicit authored spend cap and a declared evaluator `decisions:typesafe:<model>`
route. Calls reserve and charge USD in the evaluator request ledger, sharing the
route's request/spend limits across trials. Calibrated legacy graders, teacher
routes and other identity backends retain their existing admission restrictions.

The result records `identity.calibration.mode: identity`, question definitions,
backend identity and prompt version. Question calibration status is `uncalibrated`;
all labeled-observation counts are zero. No fitted accuracy is implied. Raw 0 and 1
remain exactly 0 and 1; no clipping, Platt scaling or teacher escalation occurs.
`grader calibrate` refuses this mode. `grader validate` validates authoring without
provider construction and returns `calibration: false`.

For question i, code sums the probabilities of its expected options; the grade is
`sum(weight_i * P(expected_i)) / sum(weight_i)`. Yes/no `expected` is a quoted YAML
string, `yes` or `no`. The generic legacy choice/score formats remain available.
There is no new severity field; use weights or existing gate questions where needed.
The human dataset policy chooses 6–10 questions; the generic schema does not enforce
that count. Use article-level questions without `when` for the simple fixed design.

Missing answers or bound observations stay missing, retain their weights and
prevent pass. Nonfinite, out-of-range, incomplete, extra-key or non-normalized
probabilities refuse; unknown/duplicate result keys refuse. TypeSafe's existing
rounded-distribution normalization remains at the transport boundary. Backend
identity is checked before and after grading. A new question definition changes
both protected-file and scoring identity; rescoring is not a new subject trial.

## Per-case data and private hooks

```yaml
schema: paideia.dataset.v1
id: fixed-cases
records:
  - id: delivery
    input: { prompt: Write the notice from the public task materials. }
    outputs: { article: article.json }
    context:
      grounding: Ten items will arrive Monday. They have not arrived yet.
    checks:
      - id: reader
        eval: grader
        grader: graders/delivery.yaml
        input: artifact:article
        context: { grounding: 'context:grounding' }
```

`context:name` selects an exact top-level evaluator record-context value. It does
not select subject input or a subject-generated evidence summary. It is available
to grader bindings and text checks; missing context never becomes empty text.
The dataset identity includes the record context. Sidecar grader bytes are frozen
and checked against the runtime before scoring.

The private integration must:

1. Freeze human-authored grounding and 6–10 fixed questions/expected answers per
   moment, keyed by stable record ID. Do not derive this truth from the article.
2. Stage one evaluator-only grader sidecar per distinct question set, under the
   lowered dataset's protected root. Declare `calibration: identity`, an explicit
   TypeSafe model and spend cap; the existing Spawnfile grader path stays opaque.
3. Return `context: {grounding: frozenText}` plus record checks/stages from the
   moment `prepareCase` hook, selecting that record's sidecar. Change `newsroomWritingCheck` to accept the selected sidecar and bind
   `{grounding: 'context:grounding'}`. Preserve the accepted-filing gate and existing
   stage scoring policy; add mechanical checks and `llm-rubric` explicitly as desired.
4. Keep evaluator files/context out of the subject workspace and retain the native
   article artifact binding. Stage all selected sidecars, not only the original
   atomic grader/template pair. Supply a named `--judge` route for any LLM rubric.

No Spawnfile compiler change is needed. The private `writingContext` currently
projects article evidence, not independent human truth; it cannot supply the new
frozen grounding. Private implementation and live integration remain outstanding.
Identity-mode routes have no calibration corpus, so training does not require
calibration exclusion digests; split and sealed-test access rules still apply.

## Mechanical text checks

```yaml
- id: length
  eval: word-count
  input: artifact:article#/body
  ignore: ['\[E\d+\]']
  min: 100
  max: 500
- id: supported-values
  eval: values-in-source
  input: [artifact:article#/headline, artifact:article#/body]
  source: [context:grounding, sources/facts.md]
  ignore: ['\[E\d+\]']
  max_missing: 0
```

Both reject unknown parameters. `input` is one selector or a nonempty selector
list. Selections accept strings, finite numbers and nested objects/arrays. Both
checks collect string/number leaves depth-first in document order (array order and
JavaScript object property order), joining them with newlines; keys, booleans and
nulls are ignored. A selection with no string/number leaves is an error; an empty
string is valid. This applies to source selectors too. For example, `key_numbers:
[{label: Total items, value: 10}]` contributes `Total items` then `10`.
`input:files` uses its file values. Available selectors are `output.text`, `artifact:name#/pointer`,
`input:files` and `context:name`. Lists join with newlines. Missing input is unknown
unless the existing completed-subject artifact-absence proof establishes failure.
Missing source is unknown even when subject execution is complete. Invalid text
shapes or unreadable source sidecars are errors. Open snapshots remain provisional.

`ignore` is a list of JavaScript Unicode regular-expression strings, applied
globally in declaration order by replacing matches with spaces. It applies to both
input and source for value checks. These are trusted evaluator-authored patterns;
there is no claim that arbitrary JavaScript regexes have bounded execution time.

`word-count` requires at least one inclusive nonnegative integer `min`/`max`.
A word is a Unicode letter/digit run with optional internal apostrophes or hyphens;
other punctuation separates words. It is lexical, not locale-aware segmentation.
It returns score 1/0, referenced byte evidence and `mechanicalEvidence.count`.

`values-in-source` accepts one source or a nonempty list of source selectors and/or
contained relative text files. Source files are frozen/hashes enter plan identity
through the criterion-file loader; the subject does not supply those files.
Each numeric occurrence and each straight/curly double-quoted span must appear in
the combined source. Duplicates count separately; a number inside quotes is also
checked numerically. Empty extraction reports total 0 and score 1, not semantic
support for the text. `max_missing` defaults to 0 and is a nonnegative safe integer.
The score is always `found / total`, independently of that pass/fail allowance.
`mechanicalEvidence` reports found, total and every missing value; reason also
contains the missing list. Evidence references identify all selected source bytes.

Numeric matching uses NFKC normalization, English comma/space/apostrophe thousands
groups, dot decimals, signs, leading/trailing zeros, percent signs and the currencies
USD/$, EUR/€, GBP/£ and JPY/¥. Units remain significant: 25%, 25, USD25 and EUR25 are
different. Integer normalization uses strings, preserving large integers exactly.
Numbers match whole tokens, never digit substrings. Double-quoted spans match a
case-sensitive substring after NFKC, collapsed whitespace, straightened curly
quotes/apostrophes and normalized Unicode dashes on both sides. Leading/trailing
punctuation is trimmed: `"disguised coup,"` matches `disguised coup.`. Inner text
and punctuation otherwise remain exact; `"disguised, coup"` does not match.
Punctuation-only quotes fail. Source quotation marks are not required.
Spelled numbers, locale decimal commas, unit conversion,
scientific notation and semantic entailment are unsupported.

Known false-positive classes: dates can share numeric fragments despite different
dates; years can appear in unrelated statements; ordinal digits may match cardinal
quantities (and letter-suffixed ordinals may be missed). Other limitations include
unrelated occurrences of the same value, attribution, ranges, currencies with
ambiguous symbols, short quoted phrases and incorrectly grouped/localized numbers.
Use human questions for relational or factual meaning; these checks are lexical.

## Offline regrading

Given an operator-provided TypeSafe credential in the environment, a frozen grader,
an actual captured article JSON and the frozen grounding text, from a clean checkout:

```sh
npm ci
npm run build
node dist/src/cli/main.js grader validate --grader /absolute/evaluator/delivery.yaml
node dist/src/cli/main.js grader grade --grader /absolute/evaluator/delivery.yaml --output /absolute/capture/article.json --context grounding=/absolute/evaluator/grounding.md --max-spend-usd 0.50 --timeout-ms 180000 > /absolute/evaluator/grade.json
```

No subject is invoked. Context `.json` files decode as JSON; other extensions
remain exact text. Exit codes: 0 pass, 1 fail/unknown, 2 error. Standalone `grade`
runs the fixed decision grader only. Mechanical gates needing a trial snapshot
remain unknown; run dataset checks (including `llm-rubric`) against a persisted
capture through the evaluation/replay host. Do not invent a successful trial or
accepted filing from a loose article file.

Tests use local files and injected/mocked providers. They establish contracts and
accounting, not live TypeSafe availability, useful judgment accuracy or a working
private native optimization.
