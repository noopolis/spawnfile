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
- `judge.ts` writes a judge's tool-free one-agent declaration (no skills, MCP,
  memory, surfaces or schedule), pinning model and effort only where the engine's
  descriptor makes model selection configurable.
- `launcher.ts` is one run: lazily starts the gateway from the first image of a
  gatewayed engine, boots trials against it, keeps one warm judge per engine,
  model and effort (booted through the same trial path), and `close` tears the
  judges down and stops the gateway. The gateway holds every gatewayed login
  the run's auth profile imported, read only from the profile, never a
  personal engine home.
- An engine whose login is one exclusive keyring realm (descriptor staging
  `secret-service`: AGY) is not gatewayed. Its organizations boot with no
  gateway, on Docker's default network (the engine needs egress), mounting the
  profile's own realm and unlock volumes (`auth.realms`, from
  `spawnfile auth login`) through a profile view holding nothing else.
  Daimon's flock admits one container per realm, so `realmTurns.ts` gives every
  such container of the run a first-come turn on the realm: trials hold it from
  boot to teardown; the judge stays warm while nobody waits and hands over
  after its current judgment when someone does (its image is kept), with a
  bounded wait so a judgment can never deadlock behind an open trial. Across
  processes the realm mount's `exclusive-reattach` reservation refuses a second
  holder before it starts. Codex and Grok parallelism is unchanged.
- `login.ts` is `spawnfile auth login <engine>`: it creates the profile's realm
  and unlock volumes (the unlock secret generated inside a network-less
  container as the organization uid, never on the host, never replaced), runs
  the image's own `auth <engine> login` (production's entrypoint command) in a
  throwaway tool-free judge organization attached to the operator's terminal,
  and records the volume names on the profile. `--dry-run` stops before the
  login and prints its command.
- Trial organizations never federate or run schedules, and hold no gatewayed
  login: an external `DAIMON_GATEWAY_URL` at boot means no gatewayed realm is
  mounted or staged.
