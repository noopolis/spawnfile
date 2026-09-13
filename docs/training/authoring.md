# YAML authoring proposal

**Draft for discussion, not an implemented schema or runnable configuration.**
Do not implement the parser, evaluator or runtime adapters until the user approves
the authoring surface. The architecture is approved; these field names and defaults
still need agreement. Examples below are synthetic and do not reproduce project data.

## Four separate declarations

| Declaration | Owns | Must not contain |
| --- | --- | --- |
| Agent | Source instructions, skills, references, editable components | Test answers or deployment credentials |
| Case | One task, visible inputs, reset state, expected outputs, evaluation rules | Vendor command lines |
| Dataset | Case membership, shared rules, train/validation/test splits | Mutable agent sessions |
| Experiment | Agent + dataset + runtime profile + optimizer/judge routes + limits | Copies of private authentication material |

Projects own these declarations and their source files. Paideia owns the generic
resolver, adapters and evaluator registry. Changing projects changes references;
changing runtimes selects another adapter, subject to its declared capabilities.

## Agent source files

An example `agent.yaml`, stored in the project being evaluated:

```yaml
schema: paideia.agent.v1
id: reporter
resources:
  identity:
    role: identity
    file: ./agents/reporter/SOUL.md
    optimize: false
  instructions:
    role: instructions
    file: ./agents/reporter/AGENTS.md
    optimize: true
  reporting:
    role: skill
    directory: ./agents/reporter/skills/reporting
    optimize:
      files: [SKILL.md]
  style:
    role: reference
    file: ./guides/style.md
    destination: reference/style.md
    optimize: false
instruction_order: [identity, instructions]
```

- `role` declares how a resource is consumed; a filename alone does not do that.
- A skill directory preserves its `SKILL.md`, referenced Markdown and relative links.
  Only the listed files may change. Files not explicitly editable are locked.
- Multiple resources of a role are allowed. IDs are stable; `instruction_order`
  lists identity/instruction resources once each. Mapping order never sets precedence.
  References have explicit workspace destinations; native skill placement belongs
  to the adapter. Discovered skill metadata is distinct from loaded skill content.
- A candidate records source bytes, proposed bytes, parent ID and content digests.
  Trials use isolated copies. Optimization does not edit the source checkout in place.
- Plain Markdown is sufficient. An optional explicit template can render named text
  components; templates are not required and their engine remains a separate decision.
- Editing selected sections needs stable section IDs and deterministic replacement.
  Whole-file editing is the initial simple surface; arbitrary search-and-replace is
  not a trustworthy section boundary.
- Runtime boilerplate, permissions, fixture truth and evaluation criteria are locked.
  Editable identity is an explicit future authoring decision, not the default.

## A minimal case record

```yaml
schema: paideia.case.v1
id: arithmetic-01
input:
  prompt: Reply with only the result of 2 + 2.
checks:
  - id: answer
    eval: equals
    input: output.text
    value: "4"
```

This means one fresh isolated trial, one user task and an exact final-text check.
There is no implicit trimming or case folding. An author who wants normalization
declares it. `checks` is shorthand for a single stage whose gate requires all checks.
Cases with `stages` use the same check nodes; `checks` and `stages` are mutually
exclusive. A case contains at least one check, and check IDs are unique within it.

## Supplying structured input and files

```yaml
schema: paideia.case.v1
id: short-note-01
group: transport-order-a
input:
  prompt: |
    Read evidence/source.md and write a short note to out/article.json.
    Use the requested language and maximum word count.
  data:
    language: en
    maximum_words: 180
  files:
    - source: ./fixtures/order-a/source.md
      destination: evidence/source.md
      access: read-only
outputs:
  article:
    path: out/article.json
checks:
  - id: format
    eval: json-schema
    input: artifact:article
    schema: ./schemas/article.json
  - id: no_internal_leak
    not:
      eval: contains-any
      input: artifact:article#/body
      values: ["the supplied record", "this filing can say"]
```

Only `input` and the agent's declared resources are exposed as task material.
`data` is delivered as a labeled deterministic JSON context block after the prompt;
the exact combined message is recorded. Files are materialized at declared relative
workspace paths. Copying a file does not imply reading it. Read-only is a required
isolation capability, not a claim established by a prompt or a file mode alone.

`outputs` names what to collect; it does not create the files. A requested path must
appear in visible task instructions when the agent needs to know it. Expected answers,
rubrics, dataset split labels, checks and score weights are evaluator-only by default.
Any criteria deliberately shared with the agent must be declared as visible input.

Paths resolve relative to the document declaring them, within explicitly authorized
source roots. Destinations are relative to the trial workspace. Reject traversal,
collisions and symlink escapes. Freeze and hash dependencies before the run; never
resolve a moving source checkout again halfway through an experiment.

## A complex record: procedure, evidence and writing quality

`filing-sandbox`, `editorial-judge` and other named integrations below refer to
project-registered, versioned profiles. They are not built-in newsroom behavior.

```yaml
schema: paideia.case.v1
id: validated-note-01
group: transport-order-a
input:
  prompt: |
    Read evidence/source.md. Write out/article.json using your reporting skill.
    Validate the article, file the validated version, then notify the editor
    with its accepted receipt. Use the reporter byline.
  files:
    - source: ./fixtures/order-a/source.md
      destination: evidence/source.md
      access: read-only
fixtures:
  tools: filing-sandbox
  memory: reporter-before-assignment
outputs:
  article:
    path: out/article.json
stages:
  - id: mechanics
    checks:
      - id: format
        eval: json-schema
        input: artifact:article
        schema: ./schemas/article.json
      - id: handoff
        eval: tool-sequence
        order: happens-before
        steps:
          - tool: validate
            where: {cel: 'call.result.status == "passed"'}
            bind:
              digest: call.result.artifact_sha256
          - tool: file
            where:
              cel: >-
                call.result.status == "accepted" &&
                call.args.artifact_sha256 == bindings.digest &&
                call.result.artifact_sha256 == bindings.digest &&
                call.result.author == "reporter"
            bind:
              receipt: call.result.receipt_id
          - tool: notify
            where:
              cel: >-
                call.result.status == "delivered" &&
                call.args.recipient == "editor" &&
                call.args.receipt_id == bindings.receipt
      - id: durable_copy
        eval: project/filing-receipt
        artifact: article
        expected_author: reporter
        sequence: handoff
    gate:
      all:
        - {passed: format}
        - {passed: handoff}
        - {passed: durable_copy}
  - id: quality
    when: {passed: mechanics}
    checks:
      - id: grounding
        eval: llm-rubric
        input: artifact:article
        evidence: ./fixtures/order-a/source.md
        judge: editorial-judge
        rubric: ./rubrics/grounding.md
        minimum: 0.90
      - id: prose
        eval: llm-rubric
        input: artifact:article#/body
        judge: editorial-judge
        rubric: ./rubrics/prose.md
        minimum: 0.70
    score:
      linear: {grounding: 0.70, prose: 0.30}
      minimum: 0.85
    gate:
      all:
        - {passed: grounding}
        - {passed: prose}
        - {score: quality, at_least: 0.85}
```

This checks an observed procedure; it does not tell Paideia to execute those tools
for the agent. The trusted fixture journal supplies outcomes and immutable artifact
identities. `project/filing-receipt` verifies final file bytes, accepted durable bytes,
author and same-run receipt against the sequence bindings. It must be registered and
implemented by the project before this case can run. An agent claiming it filed is
not evidence that it filed.

`tool-sequence` requires successful completed calls in the same trial. Each preceding
completion must causally precede the next dispatch. Unrelated events may occur between
steps. Independent tool existence checks impose no order. Bindings are scoped to a
matched sequence; matches must not combine unrelated attempts into a fictitious chain.
The proposed default is existential: at least one valid chain, with deterministic
selection among multiple matches. An author can separately forbid failed attempts or
require an exact chain. Bounded matching must report exhaustion, not silently pass.

## Composing other rules

The same check node can contain `all`, `any`, `not`, an evaluator invocation or a
typed reference to an already resolved check. For example:

```yaml
- id: research_requested
  any:
    - eval: tool-called
      tool: research.request
      outcome: succeeded
    - eval: tool-called
      tool: research.cached_lookup
      outcome: succeeded
- id: no_direct_search
  eval: tool-count
  tool: browser.search
  phase: dispatched
  equals: 0
- id: relevant
  eval: embedding-similarity
  input: artifact:article#/body
  reference: ./fixtures/order-a/abstract.txt
  model: relevance-embedding
  metric: cosine
  calibration: ./calibration/relevance.json
  minimum: 0.80
```

Logical tool names map to declared runtime tools or trusted fixture operations. A
shell command mentioning a name does not satisfy `tool-called`. An absence/count
claim requires complete observation of its declared scope; preventing network access
also requires enforcement, not merely a test against one known search-tool name.

CEL is proposed for typed data predicates such as argument/result comparisons, not
for executing tools, fetching files or calling a judge. Paideia owns event matching,
unknown/coverage semantics, dependencies and scoring around those expressions.
The TypeScript implementation still needs selection and conformance checks.
[CEL environment and evaluation model](https://cel.dev/overview/cel-overview).

Reusable parameterized rulesets should use a typed `use` + `with` reference to a
declared project registry. Expansion must preserve original source locations and
reject cycles/unknown parameters. Dataset defaults may add named shared checks;
records must not silently overwrite a mandatory check or inherit unrelated criteria.

## Datasets

An example `dataset.yaml`:

```yaml
schema: paideia.dataset.v1
id: reporting
splits:
  train:
    - ./cases/train/order-a.yaml
    - ./cases/train/order-b.yaml
  validation:
    - ./cases/validation/order-c.yaml
  test:
    - ./cases/test/order-d.yaml
```

A dataset is a manifest of task records, not a transcript of one continuously living
agent. Each repetition gets fresh state. Files may be organized by suite and scenario
instead of split; the manifest, not the directory name, determines membership.
Reject duplicate case IDs, repeated membership and a `group` spanning splits.
Related evidence, paraphrases and memory variants share a group to prevent leakage.
Globs, if added later, must resolve once into a frozen explicit manifest before use.
For optimization, require an explicit group even when it equals the case ID. A linter
can catch declared overlap; detecting undeclared semantic overlap needs dataset review.

Proposed aggregation: average repetitions within each case, then weight cases equally
unless the dataset explicitly declares fixed case weights. Missing trials retain their
denominator and uncertainty; they are not removed to improve the mean. Report per-case
results and failed gates alongside aggregate scores. Selection requires the declared
gates and observation coverage, not merely the highest number.

Training provides optimizer feedback. Validation selects candidates. The sealed test
compares the frozen candidate with the baseline after selection, without feeding
results back into this optimization. Reusing test feedback in a later revision turns
that test set into development data. One example per split demonstrates syntax only;
it cannot establish statistical generalization.

## Experiment and training

```yaml
schema: paideia.experiment.v1
agent: ./agent.yaml
dataset: ./dataset.yaml
runtime: ./profiles/daimon.yaml
optimizer:
  engine: dspy-gepa
  inference: subscription-reflection
  max_rounds: 3
evaluation:
  repetitions: 2
limits:
  wall_time_minutes: 30
```

Runtime/inference profiles resolve through explicit registered integrations with
runtime, model and implementation versions locked in the resolved experiment.
`subscription-reflection` is a selected authenticated CLI route, not an API fallback.
The judge and subject have independently selected routes. Runtime limits, tool fixtures
and memory backends are explicit capabilities; unsupported requirements stop preflight.

DSPy proposes changes only to declared editable text, through an explicit native
component mapping. Every changed candidate runs the real agent again. Merely rescoring
an old capture cannot measure the effect of a new prompt. Multi-file DSPy propagation
is an integration proof still to build, not a capability supplied by YAML or templates.
Report quality, coverage, latency and measured usage separately; absent usage is unknown.

## Result semantics

- `pass`: the criterion is met; a normalized score can still be fractional.
- `fail`: observed evidence violates the criterion.
- `unknown`: observation is insufficient; this cannot satisfy a mandatory gate.
- `error`: evaluator/runtime failure, invalid data or exhausted evaluation budget.
- `skipped`: a declared dependency/condition prevented evaluation; never success.
- `not` reverses only pass/fail. `all` passes only when every operand passes;
  `any` passes when an operand passes. Decisive outcomes do not erase diagnostics
  or missing coverage of other operands. Unknown conditions remain unresolved.
- Stages execute in array order; `when` controls eligibility. Checks can run together
  unless a result dependency requires order. This schedules evaluation, not the agent's
  workflow. A failed gate skips its dependent costly judges.
- All weights are finite, nonnegative and sum to one. Missing/skipped contributions
  retain their weight; never renormalize the remaining scores into an inflated result.
  Report observed contribution and missing weight. Mandatory gates and required
  scoring coverage must pass before a candidate is eligible for selection.
- Require a terminal run result and expected output evidence; startup or exit zero
  alone is insufficient. Truncated traces cannot prove absence.

YAML parsing must reject duplicate keys, unknown fields and executable custom tags;
typed references must reject cycles and unresolved targets. Ordinary strings are
literal. No shell or JavaScript expressions are embedded in cases. Future multi-turn
cases must explicitly declare turns and state continuity within one record; they must
not resume another record's session. This draft's examples are single-turn.

See [native harnessing](harnessing.md) for how resources and task inputs reach agents.
