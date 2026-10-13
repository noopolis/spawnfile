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
    boundaries: []
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
mode and measures canonical instruction-unit changes; formatting, reordering, repetition and heading-label changes
alone do not pass. `proposal.hypothesis_similarity` defaults to `0.6` (range
`0..1`) and rejects hypotheses at or above that content-token similarity.
`patience` defaults to the round count (no earlier stagnation stop). Boundaries
are verbatim strings, each 1..500 characters, at most 50; the default is empty.
Supported declarations use an operation followed by a JSON array of strings:

```yaml
boundaries:
  - 'preserve ["contract.md"]'
  - 'require-text ["AGENTS.md", "Use schema v1."]'
  - 'forbid-text ["AGENTS.md", "Use schema v2."]'
```

`preserve` locks the named component to its original seed text across all rounds.
`require-text` and `forbid-text` check case-sensitive literal substrings in the
named component. All constraints must pass. Component names are the exact editable
component keys reported by the optimizer (including section keys when applicable).
Unknown components, malformed declarations and free-form prose fail before any
callbacks; seeds violating a constraint also fail. The Python admission gate rejects
violating proposals with `hard-boundary` before trials and allows bounded repairs.
The TypeScript host independently checks constraints before native evaluation and
when verifying returned candidates. Constraints bind checkpoint identity.
These are text guarantees, not semantic or runtime behavior guarantees: keeping a
sentence does not prove an agent follows it or prevent contradictory paraphrases.
With no declared boundaries, selected editable components may be rewritten.

`max_attempts` remains `2` (range `1..5`); omitted `training.budget.max_proposals`
is `rounds * (keep + variants) * max_attempts`. An explicit cap must be at least
`keep + variants`; the existing 1000-proposal ceiling still applies, so declare
a smaller cap if the derived value exceeds it. Planning and realization both
consume this cap. Insufficient remaining proposals or trials ends search early.
The dry-run plan reports effective search controls and whole-file or heading
scope for every editable resource; candidate provenance records component scope.

The optional `SpawnfileCliIntegration.trainingOptimizer(context)` seam supplies
resolved `{ method, model, variants, keep, budget: { rounds }, boundaries? }` without importing
Spawnfile. Resolve its model by a declared model key first, otherwise by exactly
one declared model value. YAML declarations must agree with the resolved fields;
conflicts and ambiguous model names fail before any native or inference work.
Integration boundaries use the same limits (50 strings, 1..500 characters each).
If both sources declare boundaries, arrays must match verbatim and in order;
otherwise the declared source is used, including an explicitly empty array.
Frozen comparison mode bypasses this inherited optimizer resolver. Explicit YAML
optimizer settings and conflicting CLI flags still fail comparison preflight.

See [training configuration](training-configuration.md) for named routes and legacy proposal controls.

The bridge's instruction-change v2 joins wrapped list/paragraph lines, treats
Setext and ATX headings as unscored labels, and strips emphasis/link syntax.
HTML comments, closed leading YAML front matter and single-line link reference
definitions are metadata, excluded before unit segmentation. Fenced examples remain
scored literal content. This is a deterministic heuristic, not a semantic classifier.
Repeated canonical units count once per component. Whole-unit ordering is irrelevant. Independent rules split alike at periods, commas and semicolons;
conditional/workflow clauses stay together. Adjacent-token features distinguish
directive/action reversals within a clause as well as between condition branches.
Historical bundles use the same zero-distance equivalence, even if the original
candidate has left the population or the configured novelty floor is zero.
Repairs compare hypotheses only with other slots and earlier rounds.

Provenance labels behavioral/lexical distances `changeEvidence: bridge-reported-v2`.
The host does **not** independently verify these heuristics or certify novelty.
It binds accepted component bytes and hypotheses to recorded realization responses
and verifies seed training, strategy counts, attempts/status, validation scores,
lineage, retention and stop feasibility. A pre-round budget stop checks whether
any retained parent is unfundable; the unrecorded next Python shuffle is not replayed.
