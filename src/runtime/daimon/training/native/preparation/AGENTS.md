# Native subject preparation

Owns the engine-neutral execution half of preparing one native trial on a leased
slot: freshness nonce/generation sequencing, provisioner result validation against
launch.v2 and the lease, trial path binding, per-engine input and scratch layout,
and compiled engine config checks. Integrations supply a `SubjectProvisioner`
(Spawnfile's training lease satisfies it structurally); Paideia never imports
Spawnfile, recomputes digest-bound broker inputs or chooses slot paths.

- A broker slot mints its nonce from the experiment freshness store BEFORE the
  provisioner runs; the result must echo it and pass `grokBrokerLaunchSchema` and
  `assertLeasedLaunch` before any trial bytes are written. Shared-uid admits Codex
  only and mints nothing; a Codex result is returned unchanged.
- Use the `receipt/`, `container/` and `child/` public indexes only.
- Tests use fake provisioners and real temporary directories; they never claim a
  real slot recycle. Keep negative checks for every guard.
