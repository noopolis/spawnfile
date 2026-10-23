# Token efficiency with quality floors

The mechanical `token-efficiency` evaluator gives a continuous reward for using
fewer subject tokens. Keep the existing quality gates: cheaper work cannot
compensate for unsupported claims or unacceptable prose.

This stage fragment allocates 80% of the weighted score to quality and 20% to
efficiency. It keeps grounding at 0.90 and prose at 0.80. The named judge and
article artifact must already be declared by the dataset.

```yaml
id: writing
checks:
  - id: grounded
    eval: llm-rubric
    input: artifact:article
    evidence: input:files
    judge: editorial-subscription
    rubric: {prompt: Grade support for material claims and cite evidence spans.}
    minimum: 0.90
  - id: prose
    eval: llm-rubric
    input: artifact:article#/body
    judge: editorial-subscription
    rubric: {prompt: Grade clarity and paragraph progression; cite concrete passages.}
    minimum: 0.80
  - id: efficiency
    eval: token-efficiency
    metric: total
    target_tokens: 40000
score:
  linear: {grounded: 52, prose: 28, efficiency: 20}
gate:
  all:
    - {passed: grounded}
    - {passed: prose}
```

`target_tokens` is a positive safe integer and an explicit normalization reference,
not a cap or stopping budget. The score is `target / (target + measured)`:

| Measured tokens | Efficiency score | Contribution at weight 20/100 |
|---:|---:|---:|
| 20,000 | 0.667 | 0.133 |
| 40,000 | 0.500 | 0.100 |
| 80,000 | 0.333 | 0.067 |

Any trustworthy count produces `pass` with its fractional score; `pass` means the
measurement was available, not that a budget was met. A known zero produces 1.
A higher count still has a positive score. Choose the reference before training
and retain the same criterion for validation and sealed test.

- `metric: input` uses the native subject's input total.
- `metric: output` uses its output total.
- `metric: total` adds those two totals once, rejecting an unsafe sum.

Cached input and reasoning tokens are already subsets of these totals and are
never added again. Judge, embedding and optimizer calls are excluded. This is a
token metric; API-equivalent cost remains separately reported.

The snapshot must be closed and `subjectUsage.status` must be `complete`. Relevant
totals must be known, nonnegative safe integers. Legacy captures without subject
usage, incomplete captures, missing totals and invalid numbers return `unknown`
without a score. The weighted denominator retains the missing 20% contribution;
it does not silently redistribute that weight to quality.

An open snapshot is `unknown` and provisional. This evaluator cannot authorize a
live hard stop, including through a negated wrapper. Its versioned measurement
uses captured native totals when rescoring; it never invokes the subject again.

Selection can trade quality against efficiency only above the independent hard
floors. A better combined score need not consume fewer tokens: a quality gain
may outweigh an efficiency loss. Native runs also vary. The optimizer cannot
promise monotonically decreasing token usage; compare the actual selected and
baseline results on held-out cases.
