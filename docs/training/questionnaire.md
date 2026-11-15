# Questionnaire check and prompt critic

The canonical account of the two training verifiers that guard against a prompt learning its
grader: the `questionnaire` check and the prompt critic gate. Both ask a named judge route; neither
adds a model path.

## The `questionnaire` check

A check node like any other: it has an id, sits in `checks`, takes a `score` weight and may be listed in `gate`.

```yaml
checks:
  - id: house-rules
    eval: questionnaire
    bank: grading/questions.v1.yaml      # sidecar, frozen into the plan digest
    input: artifact:output               # the graded artifact
    context: { evidence: context:evidence, assignment: context:assignment }
score: { linear: { house-rules: 0.7, length: 0.3 } }
gate: { all: [{ passed: house-rules }] }
```

- `score` is the whole bank's score, open and hidden questions together. Search and selection use it.
- `status` is the bank's gate: `fail` when a gate question fails, `error` when a gate question has
  no usable answer, `pass` otherwise. A check that fails its gate still scores.
- Every context the bank reads must be bound; every judge it names must be a declared route.
  Both are refused at dataset resolution, before any trial.

## Bank (`spawnfile.training.questionnaire.v1`)

```yaml
schema: spawnfile.training.questionnaire.v1
id: house-rules
version: 2
instructions: |            # the judge's role and the terms the questions use
  You are a strict copy-desk checker. ...
reads:                     # what the judge is shown, in this order
  - output.headline                                        # scalar: "HEADLINE: ..."
  - { from: output.body, title: BODY, list: P }            # P1: ..., P2: ...
  - { from: output.rows, title: FILED ROWS, list: E,
      template: "{source} | as_of {as_of}\n  fragment: {fragment}" }
  - { from: context.evidence, title: OTHER ROWS, list: X,
      distinct_from: output.rows, by: [source_url, fragment] }
defaults: { judge: strong, effort: medium, repeats: 1, combine: majority }
groups:
  - id: fidelity
    combine: any-fail
    questions:
      - { id: sentence_support, type: free-text, ask: "For each sentence, the rows that support it." }
      - id: unsupported_claims
        type: multiple-choice
        ask: How far does the body go beyond the rows?
        options:
          - { id: none, when: every claim is stated by a row, score: 1 }
          - { id: minor, when: wording a little beyond a row, score: 0.5 }
          - { id: material, when: a fact with no row, score: 0 }
        gate: true
        weight: 2
        rule: evidence fidelity
  - id: house
    after: [fidelity]
    receives: [fidelity.sentence_support]
    questions:
      - id: rows_unused
        type: number
        ask: How many verified rows does the body never use?
        bands: [{ max: 1, score: 1 }, { max: 3, score: 0.75 }]   # above the last band: 0
        hidden: true
        rule: use the filed rows
```

Groups:

- One judge call per group per repeat, groups in the order written, steps in the order written.
- `after` names earlier groups; `receives` hands named working steps of those groups to this group's judge.
- `judge` names a declared judge route. `effort` is a requirement on that route: a route built with
  another effort is refused, never silently used. `repeats` is 1 to 8. `combine` folds repeats:
  `majority` (a tie takes the lower score, a number takes the median), `any-fail`, `all-fail`, `mean`.

Answer types:

| Type | Fields | Scored |
|---|---|---|
| `yes-no` | `yes_when`, `no_when`, `pass: yes \| no` | 1 or 0 |
| `multiple-choice` | `options`, each `id`, `when`, `score` from 0 to 1 | the option's score |
| `number` | `pass_when: { min, max }` or rising `bands` | 1 or 0, or the band's score |
| `free-text`, `extraction-list` | none | never; working steps only |

Per scored question: `weight` (default 1), `pass_min` (default 0.5), `gate`, `hidden`, `na_when`
and `rule` (required). A working step takes only `id`, `type`, `role` and `ask`.

The judge sees questions, criteria and option ids. It never sees scores, weights, gates or hidden flags.

Reads:

- `from` is `output`, `output.<field path>` or `context.<name>`. A scalar renders as one
  `TITLE: value` line; anything else as a titled block. An absent value renders `(none)`.
- `list` labels array items (`P1`, `P2`). `template` renders each item from `{field.path}`
  placeholders; a template line whose placeholders are all absent is dropped.
- `distinct_from` with `by` drops items already present in another read.

## Strict answers

- The reply is constrained to one typed property per step and then parsed again by the evaluator.
- An answer outside the declared type, `na` without `na_when`, or a missing answer is an `error`:
  it scores 0, is listed, and can never pass a gate. A gate question in error makes the check `error`.
- A judge call that fails leaves every answer of its group an error. Nothing is retried by the check;
  the route's own attempts apply.

## Hidden questions

- Excluded from everything the optimizer reads. `trainingFeedback` shows a questionnaire check only
  through its open projection: the open score, the gate over open questions and, per failed open
  question, its id, text, answer and reason. No hidden id, text or reason, no working step, no full score.
- Included in the check's score, so in search and candidate selection.
- Reported separately: the training report gives, per candidate and split, the full, open and hidden
  scores and the open minus hidden gap, with every question's pass rate.
- The trial scalar the search receives includes hidden questions. That is the point, and it is the
  only way hidden results reach the optimizer.

## Prompt critic gate

```yaml
training:
  judges: { strong: { model: strong } }
  critic:
    judge: strong
    guide: [docs/WRITING.md, docs/ARTICLE_FORMAT.md]   # relative to the train dataset
    show: [checks, train-tasks]
    block_on: high
```

- After the search and before selection is frozen, candidates are reviewed from the best validation
  score down. One judge call compares a candidate with the baseline against the guide.
- Findings: `contradicts_house_guide`, `check_only_rule` (exists only to satisfy a check),
  `case_specific` (content from a train case) and `dropped_baseline_rule`, each with the quoted line,
  the guide reference, a reason and a severity.
- The verdict is computed by Spawnfile: `block` when a finding reaches `block_on`. A critic that
  fails or returns anything else is an `error`. Both remove the candidate from selection; the next
  candidate is reviewed. The baseline is never reviewed and always stays selectable.
- A finding whose quote is not in the prompt it cites is kept, marked, and cannot block.
- `show: [train-tasks]` gives the critic the train case texts and a deterministic list of added lines
  that share uncommon terms with a train case. It is told to list case-derived lines even when they
  read as general rules; the owner decides whether they generalise. Validation cases, test cases and
  hidden questions are never shown.
- Reviews and findings are recorded in the training report under `critic`.

## Regrading recorded outputs

`spawnfile train --regrade <manifest> --auth-profile <name> --out <dir>` grades recorded outputs with
one questionnaire check on the run's booted judges and boots no subject.

```json
{ "schema": "spawnfile.training.regrade.v1",
  "check": { "id": "house-rules", "eval": "questionnaire", "bank": "questions.yaml", "input": "artifact:output",
             "context": { "evidence": "context:evidence" } },
  "judges": { "strong": { "provider": "<subscription provider id>", "model": "<model>", "reasoning_effort": "medium" } },
  "calibration": "expect.json",
  "outputs": [ { "id": "run4-baseline-case1", "candidate": "baseline", "case": "case1",
                 "output": "outputs/a.json", "context": { "evidence": "cases/case1/evidence.json" } } ] }
```

- Paths are relative to the manifest and may not leave its directory. `.json` files bind parsed values.
- `output: null` is a recorded absence and scores 0, as a failed filing does in a trial.
- Each output runs through the registered check, the engine and a one-check stage, so score and gate
  mean what they mean in training.
- Results are written one file per output under `<out>/results`; a rerun asks only for outputs whose
  judge did not answer. `REGRADE.json` and `REGRADE.md` hold per-candidate scores (missing outputs as 0),
  per-question pass rates and the calibration verdict.
- `calibration` names a set of expectations: outputs with one injected defect, the questions each
  must score lower on than its clean base, and whether a gate must fail. The command exits nonzero
  when a defect is missed, a required gate does not fail or a clean base fails a gate.

## Not implemented

- Per-check `feedback: full | status | none`, so mechanical check parameters still reach the optimizer.
- Rejecting a candidate on its open minus hidden gap or gate failure rate; the gap is reported only.
- `budget.validation_repeats`.
- Refusing a training run whose bank misses its calibration set; calibration runs through `--regrade`.
- Critic review before a candidate's first trial, and critic findings as optimizer feedback.
