# Broker-capable training container

Owns the root privilege model, slot provisioning, slot recycle supervisor and
slot preflight receipt of `spawnfile.training-container.v3` — the training
container that runs a brokered Grok subject beside the evaluator.

- `paths.ts` fixes every container path. They are constants because the root
  entrypoint, the slot supervisor and Paideia's `launch.v2` must agree on them
  without talking to each other, and Daimon's projection never resolves a path.
- `declaration.ts` is the host's read-only `spawnfile.training-broker.v1` input.
  It is data, never code: no host executable or script is ever mounted, so the
  image's own Spawnfile distribution renders the provisioning from it.
- `registration.ts` builds the one `DaimonGrokRegistration` and its deny list.
- `provisioning.ts` renders the root bash program, delegating everything below
  the slot skeleton to the production renderers in `../../containerDaimonBrokerRender.ts`.
  Never fork that program: a recycle must replay the audited start-up path,
  credential-journal recovery included.
- `processes.ts` starts the launcher (root), broker and relay (2100) and proves
  each one's socket and post-drop uid/`CapBnd` before the next starts.
- `runtime.ts` implements drain, wipe, provision, start, canaries and receipt.
- `supervisor.ts` is the one-verb root socket server. One verb, one argument,
  no caller-supplied path or command.
- `receipt.ts` writes `noopolis.daimon.grok-slot-preflight.v2`.
- `entrypoint.ts`/`main.ts` are the image's root entrypoint.

Local constraints:

- Nothing per-trial may live on the Grok realm volume. The realm holds only
  `auth.json` and the broker credential journal; the turn store, worker home,
  workspace, wake-acceptance store, per-slot ledger and Grok session state are
  per-slot tmpfs and are wiped on every recycle (R2).
- The two ledger directories are setgid to the organization group
  (`2100:2000 2750`). The broker writes rows `0640` in its own group, so
  without setgid uid 2000 cannot read a usage or inference row it paid for.
- The supervisor socket's uid gate is the socket node (`root:2000 0660` in a
  root-owned `0711` directory on tmpfs), because Node exposes no `SO_PEERCRED`.
  A `0600` root-owned socket would deny the one caller it exists for.
- A worker-uid canary over a host bind proves nothing (Docker Desktop and
  Colima ignore `chown`), so `unenforcedBindPolicy` decides between refusing
  the slot and accepting the bubblewrap deny list as that path's only boundary.
- Keep files under 400 lines and tests adjacent.
