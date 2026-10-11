# Calibrated graders

A grader scores one report against typed questions, hard gates and the evidence
its producer actually had. The grader file owns the rubric, model, teachers,
golden labels, calibration path and scoring policy. Spawnfile only maps names:
`graders: { writing: training/writing.grader.yaml }`.

## Grader format

```yaml
schema: paideia.grader.v1
id: writing
golden: writing.labels.yaml
calibration: writing.calibration.json
context:
  evidence: { description: Sources available to the report writer }
teachers:
  - { id: reader, provider: claude, model: opus }
  - { id: reviewer, provider: grok, model: grok-4.7 }
model:
  backend: ollama-logprobs
  endpoint: http://127.0.0.1:11434
  name: qwen3:8b
escalate: { to: reader, between: [0.35, 0.65], max_calls_per_trial: 4 }
uncalibrated: refuse
gates:
  - id: supported
    type: yes-no
    ask: Is every factual claim supported by the supplied sources?
    expected: yes
    reads: [output.body, context.evidence]
questions:
  - id: clear
    type: yes-no
    ask: Is the report clear and coherent?
    expected: yes
    reads: [output.body]
    weight: 2
  - id: connection
    level: paragraph
    type: choice
    options: [earned, unsupported, no-connection]
    expected: [earned, no-connection]
    reads: [paragraph, previous-paragraph]
    ask: Does the paragraph's opening connection follow from the preceding text?
score: { method: weighted, pass_at: 0.75 }
```

- `yes-no` expects `yes` or `no`. `choice` has 2–16 unique options and a nonempty
  proper expected subset. `score` has an integer `scale: [1, 5]` and expects a
  point, point subset, `">= 4"` or `"<= 2"`.
- `level` defaults to `article`; paragraph instances use `output.body` items.
  Sentence instances use English `Intl.Segmenter`; its ICU identity is pinned.
- `reads` limits each question's view: `output.<path>`, declared `context.<name>`,
  and level-local `paragraph`, `previous-paragraph`, `next-paragraph`, `sentence`.
- A structured `when: { field: output.kind, equals: report }` runs mechanically.
  A sentence `when` creates a separately labeled/calibrated `<id>.applies` question.
  Demonstrably false conditions use `not_applicable` (default 1); absent evidence
  and empty paragraph/sentence levels remain missing.
- Gates are article-level questions without weights, or ordinary `check:` nodes.
  Tool gates must prove artifact-bound acceptance: unbound `tool-called` and
  `tool-count` gates are rejected. `tool-sequence` needs an `accepted-call` ending
  and a final condition requiring argument equality to an earlier binding.
  The equality must be a positive conjunct; a binding mention or an equality
  bypassed by another Boolean branch is rejected.
- Weights default to 1 and cannot be negative; their total must be positive.
  `fitted-weights` is recognized but refused as unimplemented.

## Labels and resume

```yaml
schema: paideia.labels.v1
grader: writing
labelers:
  editor: { kind: human, name: Report editor }
labels:
  - id: report-1
    lineage: source-family-1
    output: { body: [A supported report.] }
    context: { evidence: A source excerpt. }
    votes:
      supported: { editor: yes }
      clear: { editor: yes }
      connection@p0: { editor: no-connection }
    provenance:
      editor:
        votes:
          supported: { question_digest: <current-question-digest>, projection_digest: <current-projection-digest> }
          clear: { question_digest: <current-question-digest>, projection_digest: <current-projection-digest> }
          connection@p0: { question_digest: <current-question-digest>, projection_digest: <current-projection-digest> }
```

Replace the illustrative digest placeholders with `stableDigest(question)` and
that instance’s `projectionDigest` from `expandInstances` for the resolved evidence.

`golden` may instead contain this labels body inline; `grader` is implied by the
enclosing file. Label writing requires a separate labels file and refuses inline
golden data. Referenced output/context use `{from: relative-file, sha256: digest}`;
JSON files decode as JSON and other files preserve UTF-8 text. Golden references
resolve beside the labels file, or beside the grader for inline labels. Golden
context belongs to that historical output; it is never trial-time context.

Instance keys are `<question>`, `<question>@p0`, or `<question>@p0.s0`.
Every revision of one source family shares `lineage`, the split/exclusion unit.
Optional `example: { dataset: training, id: example-1 }` binds dataset ancestry.
The input manifest uses `schema: paideia.grader-inputs.v1` and an `items` array
of `{id, lineage, output: {from: ...}, context: {evidence: {from: ...}}}` entries.

Labeling batches identical projections per teacher. One malformed-JSON repair is
allowed. Missing/abstaining votes count against a strict majority of teachers
asked for that instance; no majority means disputed. New labels persist
`askedByInstance: {<instance>: [<teacher>, ...]}` at dispatch. A dispatched failure
counts against those instances; stopped teachers do not count against later,
unasked projections. Existing labels without instance membership retain the
conservative output-wide `asked`/vote denominator. Human votes override model consensus.
One-teacher answers are explicitly marked single-teacher. `--adjudication N`
writes a local sheet containing sampled consensus instances and every dispute.

Completed outputs are persisted atomically and labeling resumes from saved votes.
Changed content, question or teacher policy makes votes stale; use `--relabel`
to replace selected teachers' votes. Human votes also require current question and
projection digests; changed questions or evidence require explicit re-adjudication.
Humans are exempt only from teacher-policy freshness. Provenance stores each grouped teacher call
once, referenced by its votes; partial resumes retain earlier receipts. Records
retain requested/reported model, provider, CLI version (null when unknown), prompt
digest, timing and usage. Older repeated call records
remain readable. Credentials never enter labels or calibration artifacts.

## Local commands

From a fresh checkout with the grader, manifest, output and context files prepared:

```sh
npm ci
npm run build
node dist/src/cli/main.js grader validate --grader training/writing.grader.yaml
node dist/src/cli/main.js grader label --grader training/writing.grader.yaml --inputs training/inputs.yaml --teachers reader,reviewer --adjudication 20
node dist/src/cli/main.js grader calibrate --grader training/writing.grader.yaml --exclude-dataset evals/test.paideia.yaml --report training/calibration.md
node dist/src/cli/main.js grader grade --grader training/writing.grader.yaml --output report.json --context evidence=sources.md
```

`grade` prints result JSON: exit 0 for pass, 1 for fail/unknown, 2 for errors,
including calibration refusal with its reason. Repeat `--context name=FILE`;
`.json` contexts decode as JSON, all others remain text. Unknown names are errors;
omitted context makes affected instances missing. Standalone grading has no trial
snapshot, so mechanical check gates remain unknown. `validate` accepts a grader
before calibration exists; `grade` requires calibration.

`validate`, `label`, `calibrate` and `grade` accept `--timeout-ms N` (default 180000, maximum
3600000). The deadline covers identity probes, scoring and teacher calls. A label
deadline preserves completed output checkpoints; rerunning resumes their votes.

## Calibration and escalation

Raw `p_good` sums probabilities of expected options. Platt scaling computes
`p' = sigmoid(a * logit(p_good) + b)`, clipping raw probabilities to
`[1e-6, 1-1e-6]`. Fit uses mean binary NLL plus
`0.01 * ((a-1)^2 + b^2)`. A question gets its own fit with at least 20 fit groups;
otherwise parameters pool by question type. Seeded lineage groups split 50/50
into fitting and held-out sets before filtering panel disputes. Disputed instances
stay out of Platt fitting, full-panel calibration metrics and fit-side band search.
Exclusions happen before inference and splitting.
Pass every validation/test dataset through `--exclude-dataset`; recorded
exclusions are part of calibration identity. An excluded record’s `group` or `id`
matching a label’s `lineage` excludes the lineage, as does an exact
`example: {dataset, id}` match (dataset ID or absolute dataset path). Spawnfile
examples without groups use their IDs and exact example matches.
Native training requires exclusions matching the current dataset source digests.
Internal validation shares its source file with training, so exclude that whole
training dataset as well as the sealed-test dataset. This conservatively removes
training examples from calibration too; use a separate golden corpus.

Held-out reports include groups, instances, base rate, accuracy, Brier score,
fit-base-rate Brier, ECE, and 90% intervals from 1,000 group bootstrap resamples.
ECE uses equal-mass bins with at least 10 observed instances, at most 10 bins.
Without a bin, ECE and its interval are `null` in JSON and `—` in the report;
the calibration bar fails as insufficient evidence. A bootstrap draw without a
bin makes the interval unavailable. Formed bins retain the missing-mass penalty. Gate
questions additionally report false passes.

| Bar | Requirement |
| --- | --- |
| Evidence | At least 15 held-out groups, 30 instances, 5 good and 5 bad |
| Calibration | ECE ≤ 0.10; 90% ECE upper bound ≤ 0.15; Brier ≤ 0.20 and below base-rate Brier |
| Gate calibration | False-pass rate ≤ 0.10, plus the other bars |

`uncalibrated: refuse` rejects any question or gate question missing these bars.
`uncalibrated: teacher` always routes such questions to the escalation teacher.
Identity mismatches always refuse: question definitions, prompt version,
segmenter, option mapping, backend/model, golden set, split seed and exclusions.
Calibration also pins the escalation teacher policy, escalation configuration
(`to`, band or target accuracy, and call limit), and `uncalibrated` policy. Any
change requires recalibration. Results additionally identify the scoring policy.

`between: [lo, hi]` escalates calibrated probabilities inside the inclusive band.
Alternatively `target_accuracy: 0.90` chooses the narrowest fitting band on a
0.05 grid retaining at least 30% of fit groups. Held-out cascade acceptance
requires target point accuracy, Wilson 90% lower bound ≥ target − 0.10, and at
least 30% retained coverage over **all eligible held-out groups**: a retained group
has at least one admitted local, non-escalated instance. Missing local decisions
do not count as retained. Gate false-pass Wilson upper bound must be ≤ 0.20.
Verification includes full-panel disputes. Truth is derived without the escalation
teacher: human votes first, otherwise strict-majority option consensus of remaining
teachers actually asked for that instance. Rows without independent truth do not
enter accuracy, but their groups still enter retained coverage. Fewer than 15
independent groups means unverified.

Forced-teacher questions (`uncalibrated: teacher` or backend `teacher`) have zero
local retention and skip only the coverage bar. Point accuracy, Wilson bounds and
independent-group requirements still apply. A failed local calibration retains its
status so runtime fallback remains forced; the report measures that routed cascade.

Escalations share one teacher call per output/projection, bounded by
`max_calls_per_trial`. Overflow and teacher failures become missing. Calls are admitted in the order of their first requested instance in expansion
order, including forced-teacher routing. Calibration and runtime share this planner.
Calibration identity pins ordered expanded question/gate IDs and definition digests;
reordering them requires recalibration.
Teacher answers map to 1 or 0 by expected membership. Calls report actual provider,
models, usage and wall time; calibration cost projections are estimates.

## Aggregation and dataset integration

A failed mechanical gate returns score 0 and fail before backend or teacher
inference, preserving gate evidence and calls. An unknown/error gate or any missing
question instance prevents pass. Each question averages applicable instances,
counting missing values as zero; every declared question weight stays in the
denominator. Complete results pass when weighted score reaches `pass_at` (default
0). Results include coverage, per-question missing/escalated counts and judge calls.

```yaml
- id: report-quality
  eval: grader
  grader: graders/writing.grader.yaml
  input: artifact:report
  context: { evidence: input:files }
```

The grader path resolves beside the dataset; calibration and golden paths resolve
beside their declaring file. The CLI confines grader/calibration sidecars to the
dataset directory; use a contained subdirectory, with no `..` traversal.
Resolution validates the grader/calibration and all
context bindings. A declared selector absent from the trial makes affected
instances missing. Check gates use the same trial snapshot. Backend/teacher
runtimes are injected through `EvaluationContext.graders`; the native CLI builds
these routes before constructing the subject adapter, refusing changed grader or
calibration files after dataset resolution. Core evaluation and
case resolution remain independent of CLI and inference implementations.
Grader/calibration digests invalidate evaluator identity, and calls serialize by
backend endpoint. Local decision billing is `local`; teacher usage stays visible.

## Decision backends and limits

- **ollama-logprobs:** an operator-supplied model/endpoint; no downloads. One
  instance per call, options A–P, temperature 0, `think: false`, `num_predict: 1`,
  `top_logprobs: 20`. Exact `X` and ` X` token masses combine. Generated tokens
  must be option letters and observed option mass at least 0.5. Each omitted exact
  variant (`X` or ` X`) has probability bounded individually by `p_min`, the
  smallest returned candidate probability. Keep the instance only when the sum
  of these bounds is at most 0.01. Preserve observed mass, add zero for each omitted
  expected variant and `p_min` for each omitted unexpected variant, then renormalize
  to obtain conservative `p_good`. Any omitted variant sets `bounded: true`;
  instances exceeding the bound are missing. Reports include missing,
  bounded and reversed-option permutation rates. Model digest comes from tags.
  Prompt/probability protocol v2 ignores v1 cached scores and requires fresh
  calibration so earlier optimistic probability bounds cannot be reused.
- **jev-http:** POST `{state, questions}` to an operator-run DecisionEngine wrapper
  using raw `temperature=1`; shared state is a JSON-encoded projection and batches
  contain at most 16 questions. Each question has `type`, `instructions`, `criteria`.
  Responses must contain stable `model` and `answers[key].probabilities` for every
  option, summing to one. Yes/no wire keys are `true`/`false`; score keys are
  zero-based scale indices; choices retain their labels. Identity uses a probe.
- **teacher:** `model: { backend: teacher, teacher: reviewer }` answers every
  instance with 0/1 outcomes. Calibration requires independent agreement ≥ 0.85
  and the same evidence bars; no ECE is claimed. All calls incur teacher work.

Claude/Grok teachers use explicitly selected subscriptions and attested empty
native tool lists. Codex is refused because its supported native invocation lacks
empty-tool attestation; observed tool non-use cannot satisfy that contract. There
is no paid API fallback, model serving, decision-head training or automatic deployment.
Without human-adjudicated examples, metrics measure agreement with teacher
consensus, not validated correctness. Protocol/unit tests do not establish live
backend availability or useful quality on a new report-writing corpus.

Label attempt provenance records sanitized `failure_kind` values, including failed
schema repairs. The command summary counts failures per teacher. Authentication,
stale-authentication and quota/payment failures stop further calls for that teacher
in the run; remaining votes stay unasked, other teachers continue, and the command
exits 1 naming the teacher and class. Already dispatched calls can finish.
