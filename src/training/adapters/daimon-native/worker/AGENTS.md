# Native Daimon adapter worker

Owns one isolated Codex or brokered Grok attention trial through the public Daimon
runtime and a caller-owned local container. Never compile organizations, reconstruct identity,
replace memory/tools, copy credentials, wake production agents or invent evidence.
Project profiles and transport bootstrap remain caller-owned. Require exact launch
receipts, authenticated native activity, closed telemetry and verified containment.
Use public module indexes across child boundaries; no sibling implementation imports.
Keep adjacent tests, files below 400 lines and per-file coverage above 90 percent.

External continuations are opt-in, sourced, bounded to three deliveries and share
one trial deadline. Deferred work is never success. Preserve per-wake evidence and
aggregate usage once; cancellation must stop the owned runtime.

The runtime wake ceiling this worker publishes is derived from that same bound
(`MAX_TRIAL_WAKES` — the task delivery plus its continuations), never declared
beside it. It is set before any delivery arrives, so a second number there drifts
from what the gate admits; hard-coded at one it admitted continuations the runtime
then never executed, and each such wake burned to the shared deadline instead. The
gate stays the exact per-trial bound and also refuses a budget above the runtime's
own per-agent execution policy. More wakes buy no wall clock and no token budget:
the one trial deadline and the epoch-wide `maxTokens` ceiling are unchanged.

Usage coverage can be complete only for one matching completed execution trace
and its single provider-complete Codex terminal total. Reject duplicate totals and
invalid cache subsets; never infer completeness from a nonempty ledger. This is
observed token coverage, not a billing or subscription-quota guarantee. A deferred
delivery may have complete usage for its closed execution; its overall subject
trial remains incomplete until the continuation succeeds and containment closes.

A closed execution leaves its delivery in one of three dispositions, and the third
is not the agent's. `completed` is the work done; `accepted` **deferred** is the
agent declining it, including the unmarked finished wake Daimon records as
deferred. `accepted` WITHOUT that marker, with the execution id retained, is
written only where a stopping runtime — or a wake that came back stopped — returns
the delivery to the inbox for restart, so it evidences nothing about the subject
and must never borrow the deferral's scored outcome. It reports as its own failure
("delivery reclaimed undisposed by a stopping runtime"); a live trial spent a wake
on the bare "ended accepted", which named a state nobody could act on.

Grok usage comes from the broker's per-slot ledger, never this process: rows need
`total = input + cache_read + cache_write + output`, the declared model (or its
`-build` alias) and a `turn` key. Byte-identical replays of one turn count once;
differing rows under one turn fail. Estimated requests keep coverage partial.
Load the Grok runtime exports only for Grok launches and fail closed if absent.

`verifyNativeWorkerStartup` is the public, side-effect-free composition of the
startup checks, for callers that must validate a prepared launch before starting
anything. It leaves out Daimon's own config parse, which needs the runtime peer,
and the worker runs it as its first step so the two cannot drift.
