# Round-based population search

```yaml
training:
  optimizer:
    method: gepa
    model: reflection
    variants: 4
    keep: 2
    budget: { rounds: 3 }
    selection: pareto
    boundaries: ["Do not disclose credentials."]
    patience: 3
    proposal:
      rewrite_share: 0.5
      min_change: 0.08
      hypothesis_similarity: 0.6
      max_attempts: 2
```

`variants` enables population mode; otherwise the existing upstream GEPA path is
unchanged. `keep` and `budget.rounds` are required positive integers, with
`1 <= keep <= variants`. `method` defaults to `gepa` and rejects any other value.
`model` remains a named model route. Each round plans distinct hypotheses, realizes
up to `variants` complete replacements and retains at most `keep` candidates.
`selection` defaults to `pareto`; `top-k` selects by validation mean alone. Both
use deterministic stable-index ties. The seed can be dropped.

`proposal.rewrite_share` defaults to `0.5` (range `0..1`), with the rewrite count
rounded up. `proposal.min_change` defaults to `0.08` (range `0..1`) in population
mode and measures canonical instruction-unit changes; formatting and reordering
alone do not pass. `proposal.hypothesis_similarity` defaults to `0.6` (range
`0..1`) and rejects hypotheses at or above that content-token similarity.
`patience` defaults to the round count (no earlier stagnation stop). Boundaries
are verbatim strings, each 1..500 characters, at most 50; the default is empty.
They are the only declared non-negotiable content constraints. Everything else
inside selected editable components may be reorganized, rewritten or removed.

`max_attempts` remains `2` (range `1..5`); omitted `training.budget.max_proposals`
is `rounds * (keep + variants) * max_attempts`. An explicit cap must be at least
`keep + variants`; the existing 1000-proposal ceiling still applies, so declare
a smaller cap if the derived value exceeds it. Planning and realization both
consume this cap. Insufficient remaining proposals or trials ends search early.
The dry-run plan reports effective search controls and whole-file or heading
scope for every editable resource; candidate provenance records component scope.

The optional `SpawnfileCliIntegration.trainingOptimizer(context)` seam supplies
resolved `{ method, model, variants, keep, budget: { rounds } }` without importing
Spawnfile. Resolve its model by a declared model key first, otherwise by exactly
one declared model value. YAML declarations must agree with the resolved fields;
conflicts and ambiguous model names fail before any native or inference work.

See [training configuration](training-configuration.md) for named routes and legacy proposal controls.
