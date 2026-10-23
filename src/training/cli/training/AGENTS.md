# Authored training command configuration

Resolve controls from the existing dataset YAML before setting the command deadline.
`deadlines.ts` resolves the 12-hour experiment, one-hour trial and 30-minute inference
defaults separately. Explicit command flags override either YAML experiment spelling;
route and atomic-extraction deadlines remain independently enforced.
CLI flags explicitly override scalar controls; judge policies remain identity-bound.
Use public inference, cases and evaluation APIs. Never execute models during dry-run.
Tests cover YAML-only control selection, provider routes and refusal before execution.

Map each declared model's native Ollama controls through the provider factory;
never apply them globally across fallback providers or silently omit them. Pass
named judge protocol alongside the frozen route/cache identity. Dry-run stays I/O-free.

Comparison YAML supplies a frozen replacement candidate, with dataset-relative bytes
read before runtime construction and hashed into command identity. It has no bridge
or optimizer route. Bypass inherited integration optimizer resolution; reject
explicit YAML optimizer declarations and incompatible optimizer/repair flags. Dry-run and execution share candidate preflight, but cost datasets remain
non-executable projections.

Provider descriptors construct one instance per purpose when required, sharing
command-owned resources through the factory context. Runtime composition owns
broker connection settings, grant pools and their isolation requirements. The
command awaits registered cleanup on every exit. Descriptors reject incompatible
fallback combinations before provider construction.

Provider caches include purpose whenever evaluator grants are supplied, even without
the broker cap, so a shared judge model cannot bypass optimizer proposal budgets.


Capped containers set `SPAWNFILE_TRAINING_MODEL_REQUEST_CAP=broker`. Reject all reachable
non-broker routes, fallbacks and legacy defaults before constructing providers,
except exact declared proposal grants wrapped in durable evaluator budgets.
Atomic grading separately admits declared extraction/decision routes; other native
graders remain refused. Grants never authorize generic judges or subject requests.
Resolve the optional public integration trainingOptimizer receipt against declared
model keys first, then exactly one model value. Conflicting YAML fields fail before
execution. Optional integration boundaries use the YAML limits and must match
verbatim/in order when both sources declare them; otherwise use the declared source.
Population search defaults are resolved by optimizer.ts; derived caps
remain within the existing 1000-call ceiling. Dry-run displays each editable
resource's whole-file or heading scope and the effective search controls.
`trainingTrialBudget` derives `(1 + variants * rounds) * (train + validation) +
2 * test * test_repeats` after dataset resolution; internal holdouts preserve the input case total.
Keep explicit caps and the 10000-trial ceiling. Verify the actual CLI/bridge run,
not just dry-run arithmetic; legacy GEPA and frozen comparisons retain defaults.

Resolve training.validation relative to its dataset and reject simultaneous validation group declarations before native construction.
