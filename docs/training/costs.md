# Cost estimates and observed usage

Paideia reports the hypothetical API price of model tokens even when a subscription
pays for inference. This is not a subscription invoice or a quota percentage.
Every named judge has its own `--judge NAME=MODEL` selection; `--optimizer-model`
selects reflection independently of the subject model.

## Before execution

`train --dry-run` resolves local candidates, datasets, partitions and cost assumptions.
It never constructs a runtime, opens authentication, starts the DSPy bridge, compiles
a workspace or calls a model. Neither `--out` nor `--bridge-command` is required.
Spawnfile's `train --dry-run` delegates to this same planner after supplying its
verified canonical source inventory.

The `paideia.training-cost-plan.v1` result includes:

- Subject trials, each named judge and optimizer proposals, with separate models.
- Development calls and two reserved held-out passes, for baseline and selection.
- Explicit token/cache assumptions, dated source prices and a USD range.
- A priced subtotal and null total when some work cannot be estimated.

The scenario assumes the entire allowed trial/proposal budget is used. Subject
token assumptions cover a whole trial, which may contain many model turns.
Default ranges are uncalibrated, not spending guarantees. Prompt growth, tool
responses and retries can exceed them. Live semantic checks have an unknown event
frequency; embedding/custom inference costs also need their own cost model. These
make the estimate partial rather than silently contributing zero.

## Calibrating a project

Pass an optional `--cost-config FILE` to train or evaluate. Ordinary runs work without
one. The strict YAML format accepts `assumptions` and exact-model `prices` overrides.
Each omitted section keeps the shipped default. For example:

```yaml
schema: paideia.cost-config.v1
assumptions:
  subject:
    inputTokens: {low: 20000, high: 180000}
    outputTokens: {low: 2000, high: 12000}
    cacheReadFraction: {low: 0.1, high: 0.7}
  judges:
    prose:
      inputTokens: {low: 4000, high: 16000}
      outputTokens: {low: 400, high: 2000}
      cacheReadFraction: {low: 0, high: 0.5}
```

These numbers illustrate syntax; replace them with recorded trials. A price override
names `model`, `vendor`, `currency: USD`, `perMillion`, `source`, `checkedAt` and
`scope`. Rates distinguish `input`, `cacheRead`, `output`, optional `cacheWrite5m`
and `cacheWrite1h`; optional `longContext` declares `aboveInputTokens`,
`inputMultiplier` and `outputMultiplier`. Exact model matching is intentional:
an alias without a sourced rate remains unpriced. Planning never refreshes prices
over the network.

## After execution

The stored report contains the cost plan and a separate `paideia.cost-report.v1`.
Its rows retain observed subject, judge and optimizer usage, model attribution,
outcomes, API-equivalent ranges and incomplete evidence. Costs persist without
the optional viewer. Failed experiments retain a progress journal and protected
diagnostics even when they never produce a completed invocation index.

Cached reads and writes are subsets of input; reasoning is included in output and
is never charged twice. Unknown cache-write duration or session context tier can
produce a price range. A run's aggregate input cannot establish each session's
long-context tier. A missing rate for observed work produces an unknown value.

Malformed judge responses preserve usage. Reused judge results are counted once
by call identity. A provider that throws before returning usage remains unknown.
Returned native turn results and usage are retained before artifact collection or
evaluation can fail. If a native turn never returns a total, persisted usage
observations remain reportable. Returned totals take precedence over observations;
multiple observations are not summed without evidence that their amounts are
disjoint. A single observed amount can contribute to the known subtotal while the
overall total remains unknown. Incomplete capture and an empty preflight never
establish complete zero spend.

Requested and provider-reported model identities stay distinct; an unreported
judge or optimizer model is not priced under its requested alias. Subject model
valuation is explicitly marked as a requested-model assumption where the native
capture does not report an actual identity.

The viewer shows persisted estimates and observed totals by role/model. Reading
the page invokes no inference. Private prompts, articles, diagnostic text and sealed
case identities do not enter shared progress projections.
