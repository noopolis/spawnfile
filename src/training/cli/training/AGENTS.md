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
or optimizer route. Reject incompatible optimizer/repair flags rather than ignoring
them. Dry-run and execution share candidate preflight, but cost datasets remain
non-executable projections.

`grok-broker` models build one provider per purpose (judge or optimizer) over a single
grant pool. The training container supplies `PAIDEIA_GROK_BROKER_CONTROL_SOCKET` and a
private `PAIDEIA_GROK_GRANT_HOME_ROOT`; missing values, a missing Daimon or a pin drift
fail every call closed. Routes may not mix `grok-broker` with `grok-subscription`.

