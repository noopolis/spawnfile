# Production-booted training trials

A training trial is the subject's real compiled organization, booted the
production way, and every trial of one run shares one login through one auth
gateway sidecar. The training core drives it through the engine-neutral
`SubjectAdapter` in `src/runtime/daimon/training/booted/`.

- `project.ts` writes the trial's one-agent organization: a copy of the
  subject agent's own declaration directory with its Spawnfile re-rendered,
  the candidate prompt as its system document, and every surface (federation),
  its schedule and its training block removed.
- `boot.ts` compiles that project under its own trial lineage
  (`TRAINING_TRIAL_LINEAGE_NAMESPACE`, so no trial ever attaches another
  deployment's volumes), builds it, and boots it with production's own
  `createDockerRunInvocation` (entrypoint, Docker security args, persistent
  mounts) joined to the run's internal network, with the gateway URL, key and
  a fresh control token as boot inputs. Wakes go through Daimon's control API
  (`POST /v2/wakes`, `GET /v2/wake-receipts/:id`) via the shared
  `runtime/daimon/control.ts` client; usage is the ledger rows the wake
  appended, transcript the engine's newest session record. Teardown removes
  the container, its volumes and its image.
- `gateway.ts` places Daimon's auth gateway as a sidecar
  (`renderDaimonGatewaySidecarScript`): production Docker security args, the
  realm volume `spawnfile-training-<profile>-<engine>-realm` (kept across
  runs: it is the login), the profile's bootstrap leaf through the same gate
  as `spawnfile up`, an internal run network (the target data-network spec)
  the trials join, and a dedicated egress network only the gateway sits on.
  Nothing is published to the host. `restart` replaces the sidecar in place
  with the same key and networks.
- `launcher.ts` is one run: lazily starts the gateway from the first trial's
  image, boots trials against it, and `close` stops it.
- Trial organizations never federate or run schedules, and hold no login: an
  external `DAIMON_GATEWAY_URL` at boot means no realm is mounted or staged.
