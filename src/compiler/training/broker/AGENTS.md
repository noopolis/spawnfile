# Broker-capable training container

Owns the root privilege model, slot provisioning, slot recycle supervisor and
slot preflight receipt of `spawnfile.training-container.v4` — the training
container that runs a brokered Grok subject beside the evaluator.

- `paths.ts` fixes every container path. Its slot descriptors are deterministic because the root
  entrypoint, the slot supervisor and the training core's `launch.v2` must agree on them
  without talking to each other, and Daimon's projection never resolves a path.
- `declaration.ts` is the host's read-only `spawnfile.training-broker.v2` input.
  It is data, never code: no host executable or script is ever mounted, so the
  image's own Spawnfile distribution renders the provisioning from it.
  Its optional `skills` carry the subject's declared skills (pinned at
  preparation from the training context) in Daimon's engine-neutral form; the
  entrypoint, supervisor and lease all resolve the projection from this one
  input, so they bind the same `skillsSha256`. Absent means no skills and a
  byte-identical declaration, registration and projection.
- `registration.ts` builds clocked slot registrations and denies sibling roots, homes and clocks.
- `clockProbe.ts` proves sibling clock masks with bubblewrap under the worker uid; its own clock must remain readable.
- `provisioning.ts` renders the root bash program, delegating everything below
  the slot skeleton to the production renderers in `../../containerDaimonBrokerRender.ts`.
  Container startup provisions the shared service once. Recycle reuses only the
  worker renderer; it never rewrites shared configuration or credential state.
- `processes.ts` starts the launcher (root), broker and relay (2100) and proves
  each one's socket and post-drop uid/`CapBnd` before the next starts.
- `runtime.ts` implements slot-local wipe, provision, canaries and receipt.
- `reset.ts` sends the broker-owned slot reset request and verifies its acknowledgement.
- `supervisor.ts` is the one-verb root socket server (one verb, slot and nonce,
  no caller-supplied path or command) and owns `startTrainingSlot`, the only
  preflight publication after shared startup. Recycles serialize per slot; different
  slots overlap. the training core must retain its exclusive slot lease throughout recycle.
- `recycleClient.ts` is the public evaluator-side client of the supervisor verb: bounded reply, timeout/abort, exact slot/nonce/protocol echo, refusal reasons surfaced. Its tests drive the real `serveTrainingSlotSupervisor` socket with only ownership facts stubbed.
- `receipt.ts` writes `noopolis.daimon.grok-slot-preflight.v2`.
- `taskClock.ts` reclaims the clock subtree only during shared startup,
  and checks installed config bytes, clock modes, library identity and worker
  access before the receipt. `projection.ts` requires Daimon's projection v3
  with `workerConfigVariant: "clocked"` and the selected digest, and refuses a
  projection whose `skillsSha256` differs from the provisioned skills tree
  (a Daimon older than 0.2.2 ignores `skills` and lands here). Recycle
  re-renders the tree into the slot's `$GROK_HOME/skills` with the production
  worker renderer.
- `seccompRoutes.ts` answers, from the pinned profile bytes alone, whether the
  worker uid may even attempt a namespace escape — the only honest way to say
  `seccomp` rather than `kernel` when a route is unavailable.
- `entrypoint.ts`/`main.ts` are the image's root entrypoint.
- `rootScript.ts` runs every generated root program (shared provisioning, slot
  wipe, recycle provisioning, clock assertions) from a fresh `0700` directory's
  `0600` script file. Never pass one as `bash -c <script>`: Linux caps one argv
  element at 131072 bytes (`MAX_ARG_STRLEN`), a skills tree pushes a program
  past it, and macOS does not enforce the cap. Never pipe it on stdin either: a
  child that reads stdin would eat the rest of the program. Worker programs
  embed each skills tree once, keyed by its digest, never once per slot.
- `evaluatorSecrets.ts` boundedly copies readonly TypeSafe ingress into `/run/paideia` tmpfs before provisioning transfers ownership. Ingress stays root-only; the final directory/file are `2000:2000 0700/0600`. Never chmod/chown the host-bound leaf or put its bytes in the global environment/logs. The subject deny mask covers both paths.

Local constraints:

- Training installs a slot-specific clocked config for every registration.
  The shared root renderer creates `/run/daimon-engine-broker/task-clock` as
  `0:0 0755`, each `slot-<n>` directory as `2100:2100 0755`, and its `faketime`
  file as `2100:2100 0644`, initially `+0\n`. Reclaim the subtree only before
  shared startup; per-slot recycle resets clocks through the broker API; root lacks `CAP_DAC_OVERRIDE` and `CAP_FOWNER`.
- Keep the clock directory and distro preload library visible through the
  pinned strict profile's read-only `/run` and `/usr` directory mounts. Never
  bind only the timestamp file: broker publication replaces its inode. Mask
  the three broker sockets individually, not their shared ancestor. Create
  broker-owned `0600` Unix socket nodes for deny-placement checks. Keep them
  through startup attestation (which runs before the backend listens); each
  listener replaces its own node. Readiness requires that replacement, not
  just a socket's existence. Daimon refuses a regular file at startup.

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
- What decides whether a worker-uid canary means anything is the **backing
  filesystem**, not the fact of being a host bind: virtiofs, grpcfuse, 9p, nfs,
  cifs and fuse ignore `chown` outright (Docker Desktop and Colima), while the
  same bind over ext4 or overlay is probed for real. Only on the former does
  `unenforcedBindPolicy` choose between refusing the slot and accepting the
  bubblewrap deny list as that path's only boundary — which is why the
  documented `refuse` default is reachable at all.
- **`/run/training/inputs` is never that.** It holds the sealed train and test
  datasets, every input is bound strictly below it, and the image bakes the
  directory itself `0:2000 0750` on the read-only root. The worker uid loses
  *search* permission on the datasets' one common ancestor; the inode is owned
  by real uid 0, which `unshare --map-root-user` does not map, so
  `CAP_DAC_OVERRIDE` in the worker's own namespace cannot override it and a
  fresh `mount --bind` of the parent re-exposes this same directory. A
  bubblewrap `deny` mask alone would not survive that route — the seccomp
  profile must allow `unshare`/`mount`/`umount2` for bubblewrap itself — so
  provisioning asserts the mode, attacks it as the worker uid over every route —
  direct, namespace unmount, namespace rebind of the parent, and a namespace
  rebind of each dataset's own mount, which is the one a mask cannot answer —
  and no `unenforcedBindPolicy` waives it
  (`.runtime/sealed-inputs-dac/EVIDENCE.md`).
- **Probe from the worker's private tmp, never `/tmp`.** The broker
  provisioning closes the shared temps to `root:2000 1774` ("workers list names
  only"), so a `mkdir /tmp/...` as the worker uid fails — which is how the first
  live run with the seal refused every trial on `namespace-rebind reached no
  verdict`. The cause was the probe's workspace, not the seal and not seccomp:
  the pinned profile allows `unshare`/`mount`/`umount2`/`setns` outright.
- **Four verdicts, never merged** (`reachable` / `denied at-read` /
  `denied at-mount` / `unavailable seccomp|kernel`), plus no-verdict, which
  refuses and prints the probe's stderr. A route the kernel will not let the
  worker attempt is a stronger denial than DAC and is recorded as such, with the
  layer named — derived from the pinned profile in `seccompRoutes.ts`, because
  errno cannot tell a seccomp `EPERM` from a kernel one. Per-route verdicts land
  in `/run/training/slots/<i>/sealed-inputs.json`; the cross-repo
  `grok-slot-preflight.v2` canary shape is deliberately untouched.
- Grok 1.0.34 materializes every `deny` target inside bubblewrap as the worker
  uid, so a deny entry it cannot create makes the whole profile fail. That is
  why `/run/paideia` is masked as a directory rather than file by file, and why
  provisioning creates every non-bind deny target itself. The wake-acceptance
  store is masked through its state-directory parent, whose ancestors remain
  searchable; a file mask beneath that `2000:2000 0700` directory would fail.
- **Nothing the launch mounts may sit inside a wipe target.** A mount point
  cannot be unlinked while it is mounted, so a recycle that must remove or
  empty a directory holding one aborts. The broker/relay `TMPDIR` lived at the
  production `<control root>/tmp`, which training clears on every recycle and
  the launch mounts as its own tmpfs — a live P8 launch died on
  `find: cannot delete …: Device or resource busy` before any model call. It is
  `/run/training/broker-tmp` now. `paths.test.ts` checks the invariant against
  the launch's own mount list, and the rendered shell
  (`MOUNT_AWARE_CLEAR_HELPER`) skips mount points regardless, so an undeclared
  one degrades to "left in place" and anything genuinely busy is reported by
  name instead of as a bare `find` failure.
- Root here holds `CAP_CHOWN`, `CAP_SETUID`, `CAP_SETGID`, `CAP_SETPCAP`,
  `CAP_KILL` and `CAP_DAC_READ_SEARCH` — never `CAP_FOWNER` or
  `CAP_DAC_OVERRIDE`. Create the whole tree while it is still root-owned, set
  ownership from the deepest path up, and reclaim an inode (and its parent)
  before chmod-ing or unlinking it.
- Keep files under 400 lines and tests adjacent.

- Worker-home and private-temp inodes retain their owner/mode throughout recycle: every
  broker turn attests all workers. Clear their contents, never remove those roots.
- Turn stores use the broker-derived `/run/training/turns/slot-<i>` layout on shared
  tmpfs; only the broker reset seam deletes a slot store or resets its clock.
- `slots.json` is generated by the launcher and bound read-only under `/run/paideia`;
  it carries exact per-slot evaluator paths and 100-port blocks starting at 20000.
- The request-budget store is a separate broker-owned persistent volume, keyed by
  the host output mount and mapped run output directory. Never wipe it on slot recycle
  or remove it with a container: resume must keep every reserved provider attempt.
