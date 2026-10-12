# Authored training command configuration

Resolve controls from the existing dataset YAML before setting the command deadline.
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

`grok-broker` models build one provider per purpose (judge or optimizer) over a single
grant pool. The training container supplies `PAIDEIA_GROK_BROKER_CONTROL_SOCKET` and a
private `PAIDEIA_GROK_GRANT_HOME_ROOT`; missing values, a missing Daimon or a pin drift
fail every call closed. The home root must be owned by the training uid with mode
0700. Routes may not mix `grok-broker` with `grok-subscription`. The command awaits
`close()` on the grant pool on every exit path (completion, failure, SIGINT/SIGTERM),
so grants are handed back instead of waiting out their ten-minute TTL.


Resolve the optional public integration trainingOptimizer receipt against declared
model keys first, then exactly one model value. Conflicting YAML fields fail before
execution. Optional integration boundaries use the YAML limits and must match
verbatim/in order when both sources declare them; otherwise use the declared source.
Population search defaults are resolved by optimizer.ts; derived caps
remain within the existing 1000-call ceiling. Dry-run displays each editable
resource's whole-file or heading scope and the effective search controls.
