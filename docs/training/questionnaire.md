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

- `feedback: full | status | none` sets what of the check the optimizer may read (see Feedback levels).
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
  A working step or hidden question named inside an open question's text or reason is replaced by
  `a withheld step` in that projection; the judge still reads the bank's own words.
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
- An optional `critic` block reviews recorded candidate prompts against a recorded baseline:
  `{ judge, guide, checks?, train_cases?: [{ id, file }], block_on?, baseline: { <prompt path>: <file> },
  candidates: { <label>: { <prompt path>: <file> } } }`. Each review is kept under `<out>/critic` and
  reported; a manifest may hold a critic block and no outputs.
- `calibration` names a set of expectations: outputs with one injected defect, the questions each
  must score lower on than its clean base, and whether a gate must fail. The command exits nonzero
  when a defect is missed, a required gate does not fail or a clean base fails a gate.

## Feedback levels

Every evaluator check accepts `feedback: full | status | none`: what of it the optimizer may read.

- `full` (the default): the check's declared parameters, status, score and reason.
- `status`: its id, evaluator, status and score. No parameter and no reason, so a threshold such as a
  word range cannot be copied into a prompt.
- `none`: nothing. The check is absent from the criteria and from the results; a stage gate or weight
  may still name its id.
- A questionnaire check at `status` shows its open score and open gate only; at `full` it adds the failed
  open questions. No level ever shows a hidden question.
- The level changes optimizer text only. Scoring, gates, selection and the operator report are unchanged.

## Repeated validation trials

```yaml
training:
  budget: { validation_repeats: 2, test_repeats: 1 }   # each 1 to 8, default 1
```

- Trial noise is about ten times judge noise, so a case is run again, never judged again.
- Each validation callback runs its case `validation_repeats` times as fresh subject trials, in turn, and
  the search receives the mean score. Train cases stay at one trial.
- The derived trial budget is `(1 + variants * rounds) * (train + validation * validation_repeats) +
  2 * test * test_repeats`. With an explicit `--max-trials` and no population search, every optimizer
  callback is budgeted as a repeated validation.
- A nondefault count is part of the checkpoint identity; a resumed run restores every repeat it holds.

## Open and hidden gap rule

```yaml
training:
  selection: { max_gap: 0.10, max_gate_failure_rise: 0.25 }   # declare either or both
```

- Measured per candidate over its validation trials: the mean open score, the mean hidden score, their
  gap, and the share of trials whose questionnaire check did not pass its gate (a missing output counts).
- A candidate is removed from selection when its gap exceeds the baseline's by more than `max_gap`, or
  its gate failure rate exceeds the baseline's by more than `max_gate_failure_rise`.
- The rule runs after the search and before the critic: a rejected candidate is never reviewed.
- The baseline is never rejected. A candidate the rule cannot measure is not rejected by it.
- Every measurement and decision is in the report under `selection`.

## Calibration before training

```yaml
training:
  calibration: [training/calibration/set.v1.json]    # relative to the declaring file
```

```json
{ "schema": "spawnfile.training.calibration.v1",
  "check": "house-rules",
  "outputs": [ { "id": "clean-a", "output": "outputs/clean-a.json", "context": { "evidence": "cases/a/evidence.json" } },
               { "id": "figure-a", "output": "outputs/figure-a.json", "context": { "evidence": "cases/a/evidence.json" } } ],
  "expect": [ { "id": "figure-a", "base": "clean-a", "defect": "figure_not_in_evidence",
                "targets": ["figures_supported"], "gate_must_fail": true } ],
  "clean": ["clean-a"] }
```

- A set names one questionnaire check of the train dataset and recorded outputs: known bad ones (one
  injected defect each, with the questions that must score lower than on the clean base and whether a
  gate must fail) and known good ones (every `base` and every `clean` id must pass the gate).
- Paths are relative to the set file and stay inside its directory. Each output binds exactly the
  check's contexts. `.json` files bind parsed values.
- `spawnfile train` judges every set on the run's own judge routes before the first trial, through the
  registered check, and refuses to start when a defect is missed, a required gate does not fail, a clean
  output fails a gate or a judgment is missing. Nothing is retried into a pass.
- Results are kept one file per output under `<out>/calibration/<set>-<digest>`. The digest binds the
  bank, the set and every file it names, so a resumed run asks only for outputs whose judge has not
  answered and a changed input is judged again.
- The verdict is in the report under `calibration`.

## Cost plan and resume

- The cost plan counts questionnaire calls as one per group per repeat for every permitted trial, the
  calibration sets' calls, and one critic review per candidate the search can produce.
- Observed costs include calibration and critic calls beside the trials' judge calls.
- Critic reviews are kept in `critic.json` beside the training checkpoint, bound to the judge, guide,
  baseline, shown checks and train cases. A resumed run reuses them; an errored review is asked again.

## A case without a grader

A dataset example may declare `grader: false`: it lowers no `grade` check, and its declared checks
grade it. `score` and `gate` then name declared checks only.

## Not implemented

- Critic review before a candidate's first trial, and critic findings as optimizer feedback.
