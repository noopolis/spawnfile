# Training Container Launcher

- One immutable image runs the whole experiment; the host only prepares declared mounts and supervises Docker.
- `contract.ts` validates explicit launch configuration. `prepare.ts` maps canonical context and CLI paths into declared mounts.
- `evaluators.ts` validates purpose/provider/model budgets and mounts a protected Paideia route receipt declaration. TypeSafe bindings require single-link canonical leaves; never emit key bytes into environment, argv or logs. Brokered v4 binds ingress readonly under `/run/paideia/secret-ingress`; the root entrypoint stages evaluator-owned tmpfs credentials. The subject's `/run/paideia` deny mask covers both paths.
- Non-brokered v1 may explicitly opt into `subjectIsolation: "codex-native-sandbox"` with a TypeSafe evaluator route (v2 preparation carries it into v1). This requires a Daimon Codex subject with strict `codex_policy: workspace-no-network`; Paideia verifies the actual native sandbox's protected-path canaries before cognition. Bind the host secret leaf readonly directly at `/run/paideia/secrets/typesafe`, the same `PAIDEIA_TYPESAFE_SECRET_FILE` consumed in v4: host-uid execution cannot create the root-staged copy. Never chmod/chown the host leaf. Model-run commands are denied `/run` and `/proc` by the Codex native sandbox, NOT by UID separation: the trusted Codex CLI and evaluator share the host uid. This opt-in declares that integration boundary; it does not add per-subject UID isolation. Secret source paths retain auth diagnostic redaction. Brokered v4 cannot use this field.
- Evaluator receipts live in the mapped `--out` run directory. Distinct outputs have independent budgets; resuming the same output retains its ledger.
- Brokered launches leave concurrency absent so comparisons stay serial; optimization defaults to the descriptor count. Explicit lower concurrency is allowed; oversubscription fails before Docker. Set `PAIDEIA_MODEL_REQUEST_CAP=broker` so uncapped inference routes fail closed.
- Native launches also mount `/run/paideia/slots.json`, using `spawnfile.training-slots.v2` with `isolation: "shared-uid"`, the host uid, disjoint 100-port blocks and empty roots. Preparation retains fresh per-trial paths; no broker roots or UID isolation are claimed. Paideia must support v2 before using these images. Concurrency validation applies to both modes.
- `nativeSlots.ts` owns that native descriptor. Native `/work`, `/tmp`, `/home/training` tmpfs ceilings scale per slot (4g, 1g, 1g), as does the 512 PID allowance. At eight slots the ceilings total 48 GiB; actual memory use still depends on the trials and Docker's memory budget.
- `process.ts` owns bounded Docker subprocess transport. `launch.ts` owns exact container identity, streaming, receipt verification and cleanup.
- `grokWriteback.ts` exports the stopped, ownership-verified broker's credential and journal privately before removal; auth owns expiry/lineage checks and atomic profile replacement. Failure and cancellation take the same path. The container never writes a host auth mount.
- Never mount a Docker socket, host home, arbitrary environment, or host executable. Auth bindings are explicit read-only leaf files.
- Dry-run stays in the existing host estimator. Actual training must never fall back to host execution.
- Docker bind mounts currently require an explicitly selected local Unix-socket context. Remote daemon staging is unsupported.
- Keep files under 400 lines; adjacent negative tests must prove ownership, cancellation and final receipt checks.

- Optional authoring execution is mapped into container addresses and bound read-only at /run/paideia/execution.json. Preserve all dataset roles, graders and optimizer controls; never extend the legacy context with execution fields.
- Fresh authored direct launches create private canonical output only after validating mounts and CLI paths. Resume requires existing output. Whole-project binds cannot contain output; use disjoint output or a preparation declaration with a selected snapshot.
- Authored launches verify dataset bytes and the immutable image's explicit execution capability label before container creation, then pass --spawnfile-execution to its entrypoint. Never auto-label arbitrary integrations as compatible.

- Explicit validation dataset paths receive the same mount coverage validation as train/test. The image consumer lowers moments inside the training container via the public moments API.

- `outputVolume.ts` owns a launch-labelled local Docker output volume by default
  on every supported local context. `outputCopy.ts` is the bounded, dependency-free
  Node copier run in the same verified image. Seed all existing output, including
  fresh-run prelaunch files and resume checkpoints; use the native host uid/gid
  or broker organization uid/gid 2000. Export assigns host ownership and retains
  modes, symlinks, hardlinks, timestamps and empty directories. Never follow source
  symlinks. Helpers have no network, socket mount, added capabilities or privileges;
  retain only default CHOWN/DAC_OVERRIDE/FOWNER/FSETID to copy private runtime files.
- Output copies are limited to 1,000,000 entries, depth 64 and 64 GiB of unique
  regular-file data plus link text. Each export Docker operation has a separate
  120-second deadline, unaffected by cancellation or the training deadline. A
  helper is ownership-verified and removed before publishing its staged output.
  The stopped writer's output reaches the host before final receipt verification;
  failure and cancellation export only after verified writer removal. Unknown
  ownership/closure or export failure retains the volume and prints recovery.
- `SPAWNFILE_TRAINING_OUTPUT_STORAGE=bind` is the explicit compatibility opt-out
  for reliable bind-mount hosts; unset or `volume` uses VM-local output everywhere
  so switching local Docker contexts never silently changes filesystem behavior.
  Other values refuse before Docker. Auth and budget volumes remain separate.
- Durability is at exit: the host output is a snapshot, not a live checkpoint
  feed. SIGINT/SIGTERM and command cancellation export during cleanup. SIGKILL,
  host/VM crashes and power loss cannot run cleanup; the labelled volume remains
  on the Docker daemon for recovery (VM disk loss still loses it). A host crash
  during the two-rename publication can leave the previous host output under the
  private scratch `output-before-export`; the volume remains authoritative until
  export and cleanup finish. Do not concurrently edit/replace host output or run
  another launch against it. No periodic checkpoint export is promised.
- `contract.ts` exports `TRAINING_FAKETIME_LIBRARY_PATH`, the image-owned symlink for caller-scoped preloading; the public training barrel re-exports it.
