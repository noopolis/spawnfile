# Native Daimon adapter container

Owns one isolated Codex attention trial through the public Daimon runtime and a
caller-owned local container. Never compile organizations, reconstruct identity,
replace memory/tools, copy credentials, wake production agents or invent evidence.
Project profiles and transport bootstrap remain caller-owned. Require exact launch
receipts, authenticated native activity, closed telemetry and verified containment.
Use public module indexes across child boundaries; no sibling implementation imports.
Keep adjacent tests, files below 400 lines and per-file coverage above 90 percent.

Separate-container Grok is unsupported and refused before any Docker call. The
unconfined seccomp/AppArmor options and the codex-auth ingress mount are Codex-only.

`manifest.ts` holds both path policies. Codex anchors the control root, control
inputs and every writable root inside the evaluator's own trial runtime home.
Grok cannot: the training container fixes `<slot>/{workspace,runtime-home,state}`
as siblings and keeps control inputs in the denied `/run/paideia` root, and none
of it can move without changing `projection_sha256`. `grok-slot.ts` reads the
root supervisor's slot preflight receipt before any process starts and supplies
the equivalent authority — the digest it certifies must be this launch's, and its
worker-uid denial canaries decide what may be a control path and what may not be
writable. Codex rules stay byte-equal; the Grok branch never runs for Codex.

`loadNativeLaunch` derives the receipt path from `realpath(runtimeHomePath)`. The
value still comes from the evaluator, never from the launch, and every check
below pins that resolved root — for Grok, to the digest-bound slot runtime home —
so resolving cannot redirect the receipt. It exists because a fixed container
slot is reached through the runner's allocated trial path, and the worker refuses
a control file whose own path traverses a symlink.
