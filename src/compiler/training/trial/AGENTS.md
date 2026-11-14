# Production-booted training trials

A training trial is the subject's real compiled organization, booted the
production way, and every trial of one run shares one login through one auth
gateway sidecar. The training core drives it through the engine-neutral
`SubjectAdapter` in `src/runtime/daimon/training/booted/`.

- `project.ts` makes the trial's one-agent organization: the subject's own
  project compiled from its own files, with in-memory manifest overrides (each
  team on the way down keeps only the member leading to the subject, no
  networks or external participants; the subject loses surfaces, schedule and
  training and takes the candidate prompt as its system document). Team
  inheritance and relative paths therefore hold as in production.
- `momentVolumes.ts` fills a record's moment (`setup.moment`) into the trial's
  own fresh volumes before boot: a root, network-less helper on the
  organization image, content streamed as a tar on stdin (no bind mounts),
  extracted as the organization uid, feeds landed as `trees/<revision>` behind
  `current` with the feed identity record, then the replacement sentinel.
- `boot.ts` compiles that project under its own trial lineage
  (`TRAINING_TRIAL_LINEAGE_NAMESPACE`, so no trial ever attaches another
  deployment's volumes), builds it, and boots it with production's own
  `createDockerRunInvocation` (entrypoint, Docker security args, persistent
  mounts) joined to the run's internal network, with the gateway URL, key and
  a fresh control token as boot inputs. Wakes go through Daimon's control API
  (`POST /v2/wakes`, `GET /v2/wake-receipts/:id`) via the shared
  `runtime/daimon/control.ts` client; a wake's `failure` is a failed
  receipt's text or, for a delivery Daimon deferred, the agent's execution
  error from `/v2/availability`; usage is the ledger rows the wake
  appended, transcript the engine's newest session record. A wake still open
  at the trial's deadline reports the same execution error (the failed
  execution behind an open retry); every failure text is whole, secrets masked. Every compiled
  volume except gatewayed realms is renamed to the trial's own
  (`TRIAL_VOLUME_PREFIX`), so no trial shares a writable volume. A moment's wake
  is `kind: message` at the moment's instant, as Moltnet delivers it; `read`
  returns a declared output from the container workspace. Teardown saves the
  container's evidence, removes the container, its (prefixed) volumes and its
  image, and resolves with the runtime's last reported failure; the launcher
  records a credential scan first.
- `evidence.ts` keeps what a container can still say before it is removed
  (`captureTrialEvidence`), in the boot's evidence directory on the operator's
  disk: the whole container log (`docker logs --timestamps`, stdout and stderr
  in separate files, never a tail) and each engine record the runtime's
  descriptor declares (`diagnostics.paths`, relative to the agent's runtime
  home; one tar per path through `docker cp`), plus `runtime-failure.txt` (the
  agent's execution error at teardown) and the `evidence.json` manifest.
  Everything is streamed through the Docker CLI to a file (no bind mount, never
  buffered whole) and through `maskSecrets` (the container's control token and
  gateway key by value, credential shapes by pattern, byte for byte so an
  archive stays valid). One stream is bounded at
  `TRIAL_EVIDENCE_STREAM_BOUND_BYTES`; a capture that reaches it, or cannot be
  made, says so in the manifest and nothing is cut silently. A declared path at,
  above or below a login file (`HOME_LOGIN_FILES`, the descriptor's credential
  destination and auth file) is refused and listed. `boot.ts` calls it in the
  one teardown every path takes (success, failure, deadline, abort, a boot that
  never became ready): stop, capture, then remove the container and volumes.
  What an engine exposes is Daimon's declaration; Spawnfile only collects it.
- `trialReads.ts` reads a running organization: usage and request ledgers, the
  engine's newest session record, the agent's execution error.
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
- Every boot has its own evidence directory: a trial's is the training core's
  (`<trial root>/evidence`, passed down by the adapter), a judge's a fresh
  `<scratch root>/evidence/judge-*` per boot.
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
  AGY's login is also a few files in its runtime home (`homeLogin.ts`: the
  OAuth token AGY rewrites on refresh, installation id, onboarded project).
  The profile's third volume holds only those: before a container starts, a
  network-less helper on the same image seeds them into its fresh home volume
  (mounted where the organization mounts it, as the organization uid); after it
  stops (inside the same realm turn) the helper writes back what AGY rewrote.
  Trials never share anything else of a home. A login recorded before this
  volume existed is refused until `spawnfile auth login` runs again.
  Daimon's flock admits one container per realm, so `realmTurns.ts` gives every
  such container of the run a first-come turn on the realm: trials hold it from
  boot to teardown; the judge stays warm while nobody waits and hands over
  after its current judgment when someone does (its image is kept), with a
  bounded wait so a judgment can never deadlock behind an open trial. Across
  processes the realm mount's `exclusive-reattach` reservation refuses a second
  holder before it starts. Codex and Grok parallelism is unchanged.
- `login.ts` is `spawnfile auth login <engine>`: it creates the profile's realm,
  unlock and home login volumes (the unlock secret generated inside a network-less
  container as the organization uid, never on the host, never replaced), runs
  the image's own `auth <engine> login` (production's entrypoint command) in a
  throwaway tool-free judge organization attached to the operator's terminal,
  keeps the login files from that throwaway home in the home login volume,
  and records the volume names on the profile. `--dry-run` stops before the
  login and prints its command.
- Trial organizations never federate or run schedules, and hold no gatewayed
  login: an external `DAIMON_GATEWAY_URL` at boot means no gatewayed realm is
  mounted or staged.
