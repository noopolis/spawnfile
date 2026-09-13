# Live evaluation and stopping

**Initial policy implemented.** Automatic task-failure stops
require explicitly selected, decisive mechanical violations. Semantic and embedding
checks may observe intermediate work but cannot stop the subject in this version.
The trial runner persists observations and checkpoints, enforces these stop rules,
and records acknowledged or incomplete cancellation. Deterministic tests cover the
policy; the newsroom-specific research audit below has not been implemented.

## Repair versus decisive failure

A failed tool call is not automatically a failed task. A reporter may repair rejected
JSON, validate again, file and notify the editor. If authored as a live check, an
existential ordered check can update during this work; a missing sequence alone
does not justify stopping.

A decisive failure means no permitted continuation can satisfy the authored criterion
over its declared scope. An observed forbidden direct-research attempt can violate
“never attempt direct research” immediately. “Eventually file valid JSON” still permits
repair. “Every filing must follow validation” is a different, stronger criterion; the
runner must never substitute it for the existing repair-friendly sequence check.

The evaluator reports verdict and finality separately. `pass`, `fail`, `unknown`,
`error` and `skipped` retain their existing meanings; finality is `provisional` or
`final` for the evaluated scope. Only `fail` plus `final`, supported by trusted
evidence and an explicit stop policy, authorizes a task-failure stop. A score below
a threshold, missing evidence, or an LLM's prediction of future failure cannot do so.

## YAML beside the existing stages

Both newsroom [training](../examples/newsroom-reporting/evals/train.paideia.yaml) and
[test](../examples/newsroom-reporting/evals/test.paideia.yaml) declare this block, whose
custom evaluator still requires a project integration:

```yaml
live:
  checks:
    - id: research_boundary
      on: event
      eval: newsroom/no-direct-research
      on_fail: stop
```

`live` is an optional dataset-level field. It contains a nonempty `checks` sequence
using the existing check-node language plus the scheduling metadata below. It applies
to every record, with record-local context bindings; records and fixtures cannot
override it. Live check IDs are unique in their own namespace and cannot be referenced
as stage gates. Omitting `live` requests terminal evaluation only.

| Field | Meaning |
| --- | --- |
| `on: event` | Reevaluate on each newly persisted relevant trusted observation, including scope closure |
| `on: {artifact: accepted-article}` | Reevaluate at each new immutable version collected for that artifact |
| `on_fail: continue` | Default: record the result; allow the subject to continue |
| `on_fail: stop` | Request stopping only on a supported final mechanical failure |

`on` is required; unknown triggers or actions fail resolution. A referenced artifact
must be declared by preparation. `on` schedules evaluation; it does not assert that
one agent action preceded another. `stages.when` keeps its existing dependency meaning.
Each update evaluates the criterion over its record scope up to the captured boundary,
not merely over the single event that triggered it. Relevance comes from the evaluator's
registered observation requirements. Existing stages remain the terminal scoring plan,
but a final failure of a stop-selected live check irreversibly fails the record;
passing stages or later cancellation-tail artifacts cannot offset it. Stop-selected
checks require a final pass over their complete record scope before claiming success;
without a decisive failure, an error closure yields record `error`, otherwise an
unknown closure yields record `unknown`. Both retain their denominator and missing
coverage; passing stages cannot promote either to success. Continue-selected results
are advisory and do not become implicit completion gates.

The initial live block has no cross-check result dependencies: result references and
`stages.when` are unsupported there. Rulesets expand into self-contained criterion trees.
`skipped` may record evaluation prevented by trial termination; it never means pass.
An artifact not yet collected creates no checkpoint; missing required evidence at scope
closure remains unknown, rather than a fabricated successful check.

The registry must declare observation requirements, incremental support and the
conditions proving final failure. A custom evaluator cannot acquire stop authority
merely from its name or `on_fail`. Stop eligibility must be checked through the entire
resolved dependency graph; wrapping an LLM/embedding score in `not`, `all`, a ruleset
or a threshold does not make it mechanical. Unsupported combinations fail preflight.

Mechanical logic may stop only with a finality proof over its relevant operands:

| Node | Final pass | Final fail |
| --- | --- | --- |
| `not` | Operand is final fail | Operand is final pass |
| `all` | Every operand is final pass | At least one operand is final fail |
| `any` | At least one operand is final pass | Every operand is final fail |

Preserve other operands' unknown/error diagnostics even when a witness decides the
composite. As a logic example, not a newsroom audit, an observed forbidden call can
make `not: tool-called` fail finally before closure; not observing it cannot make that
absence pass finally before closure.
Rulesets expand before applying these rules. Other compositions, including numeric
thresholds, need registered proof rules; unsupported stop proofs fail preflight.

### The actual newsroom boundary

`newsroom/no-direct-research` is a proposed mechanical project evaluator for
Scribe's existing instruction to use sensors. It needs an authenticated audit from
the isolated environment that identifies the acting subject and a direct-research
attempt forbidden by the fixed environment policy. A policy-denied attempt can be a
decisive witness even if no network request succeeded. Keep the policy identity,
attempt identity, native correlation and original audit evidence with the result.
Subject identity comes from the resolved native trial identity, checked against the
dataset's `subject`. The preparation recipe supplies the versioned environment policy;
its identity is frozen in the run manifest and must match the audit. No implicit
production policy is consulted. Owned child processes count as the subject when the
audit proves their execution ownership; ambiguous ownership stays unknown.

This audit and evaluator are not implemented. A shell string containing `curl`, a
tool-name blacklist or an agent's self-report cannot provide this guarantee. Model
inference, permitted Moltnet traffic, offline tools and sensor-owned requests must not
be classified as the reporter's forbidden research. Classification must be mechanical
against a declared policy, not a semantic guess about intent. Ambiguous attribution
remains unknown. Required observation support must be proved before running this plan.
Indirect bypass through ordinary messages, such as asking a colleague to fetch a
source, is outside this audit's coverage and needs separate semantic or human review.
A pass certifies the declared audited boundary only, not the entire research instruction.

### Optional semantic observation

An additional proposed live check can inspect each collected article revision:

```yaml
id: prose_progress
on: {artifact: accepted-article}
eval: llm-rubric
input: artifact:accepted-article#/body
judge: editorial-subscription
rubric:
  prompt: Identify unclear paragraphs and writing-process leaks; cite exact spans.
minimum: 0.80
on_fail: continue
```

This is a live check fragment, not another required file or an installed evaluator.
It is optional and is not added to the two datasets: their terminal writing stage
already judges prose. Intermediate semantic results are advisory for the evaluator
and viewer. They do not inject coaching into the subject, gate a later external input,
or indirectly stop a multi-wake task. Training-only feedback may reach the optimizer
under the existing split policy. The final grounding/prose gates still determine task
quality after the run; advisory during execution does not mean optional final quality.
This restriction also covers turn-level gates outside `live`: semantic/embedding
dependencies cannot block a later stimulus. They may gate only final record quality.

## Observations, checkpoints and multiple wakes

Capture persists authentic identities, deduplicates native events, and retains dispatch,
completion and durable effects separately. Evaluators use proven causal relationships,
not arrival order. A delayed validation event cannot establish an ordering violation.
An observed forbidden event can prove presence with partial capture; absence or a
missing predecessor needs sufficient completeness for the relevant scope.

Each evaluation cites its boundary, event identities and immutable artifact bytes and
digests. A later revision does not replace the evidence of an earlier judgment. Judges
observe snapshots concurrently; their late results remain attached to those snapshots.
Judge errors are recorded as evaluator errors, never converted to subject violations.

Live record scope spans all its native wakes, research waits and revisions. Memory,
workspace and conversation remain within that record; another attempt resets them.
An agent ending a wake to wait for a sensor does not close the whole record or fail
its final filing checks. Native Codex supports exact-thread continuation, per-turn mechanical gates and
trusted observation bindings for later stimuli. Daimon currently rejects multi-wake
trials because its CLI route cannot yet preserve that conversation and memory context.
Moltnet message delivery and project-specific sensor fixtures still require preparation.

## Who stops what

Evaluation supplies a decision and witness. Experiments owns the live subscription
and coordinates stopping through the subject adapter; it does not implement agent
cognition. Capture/storage retains evidence. The viewer only reads it.

On a decisive selected violation, experiments records the trigger before requesting
cancellation, prevents new trial stimuli/wakes, and asks the adapter to stop owned
work. Requested cancellation, native acknowledgement and verified quiescence are
different states. Declare the scope, deadlines and escalation covering child processes,
active tools and owned remote work. A missing acknowledgement or an unbounded remote
job must remain an incomplete stop, even if the main CLI exited successfully.

Observe and retain late effects and usage. Cancellation does not undo an already
dispatched action; this is token-saving evaluation, not a sandbox or pre-action
authorization mechanism. The native environment still enforces its own permissions.
Cancellation uncertainty cannot erase an already proven criterion failure, and a
criterion failure cannot hide incomplete cancellation or capture.

Live observation and cancellation are independently negotiated capabilities. Reject
required unsupported control before paid work; do not silently downgrade a hard stop
to terminal checking. If a required capability fails during execution, terminate the
attempt as an infrastructure interruption with explicit uncertainty, preserving any
already proven violation. Runtime budgets, operator cancellation and infrastructure
shutdown remain independent of semantic quality judgments.

## Comparison, replay and acceptance

Freeze the live plan, evaluator/policy versions, observation requirements, checkpoint
and stopping policy, budgets and retries for compared candidates. Live plans join the
normalized shared-plan digest. Keep decisive task failure distinct from infrastructure
interruption and unfinished quality checks. A cheap early failure cannot outrank a
successful task through cost alone. Preserve denominators, coverage and uncertainty;
account for all attempts, cancellation-tail usage and separately billed judges.

Playback invokes no subject or judge. Rescoring creates a new evaluation over stored
evidence; it cannot turn a truncated early-stop capture into a completed trial. Changed
candidate instructions require fresh execution. Divergence of recorded environment
responses and the detailed ranking of interrupted trials remain open contracts.

Before advertising this policy as working, demonstrate:

1. A forbidden audited attempt stops further work, with a final witness and verified
   cancellation scope; valid Moltnet/sensor/model traffic never triggers that check.
2. Failed validation followed by repair succeeds without premature termination;
   delayed/out-of-order observations never manufacture a final violation.
3. A failing or stale semantic judgment cannot stop or gate the subject, including
   through nested logic, rulesets or dependent turns; final quality gates still apply.
4. Partial capture cannot pass absence, and missing live-control support fails preflight.
5. Late side effects, missing cancellation acknowledgement and unknown usage remain
   visible; replay does not resume the subject or claim unobserved completion.

Generic live-policy conformance is covered by failing-path tests, including repair,
nested semantic-stop rejection, partial traces, concurrent observations and bounded
cancellation. The newsroom-specific audited-network acceptance in item1 is pending.
The same small terminal task and frozen prompt have passed on real Codex and Daimon;
that does not establish production newsroom or network-audit parity.

## Trial closure

Every acquired native session receives bounded terminal cleanup, including handles
that arrive after startup cancellation. The deadline covers the whole trial and
late cancellation is reconciled before the result is prepared. A selected decisive
mechanical failure skips unnecessary terminal judges; already-started advisory work
receives cancellation. Nonsettling host work remains an infrastructure failure,
separate from the preserved task-violation witness. Closed reports retain frozen
observations and live evaluations; late effects do not mutate the stored result.
