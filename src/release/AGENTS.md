# Release Guide

This folder owns `spawnfile release`: rebuild and redeploy a detached
deployment only when its image inputs changed, without killing a running turn.
The normative contract is `../../specs/RELEASE.md`.

## Structure

```text
src/release/
├── index.ts           # Barrel exports
├── types.ts           # Failure reason vocabulary, ReleaseError, outcomes, exit codes
├── releaseTypes.ts    # ReleaseRequest and the injectable ReleaseDependencies
├── runRelease.ts      # The orchestration: order, no-op decision, failure and deferral reporting
├── swap.ts            # Runtime drainability check, drain, pre-deploy confirmation, deploy
├── drainPhase.ts      # Drain marker, drain/wait/resume around a release, interrupted-drain recovery
├── drainControl.ts    # Daimon control API client (drain, resume, availability) via a same-image curl helper
├── releaseDocker.ts   # Release image tags, container inspection, settle, image pruning
├── ledger.ts          # Release ledger, append-only log, per-deployment lock, atomic JSON writes
├── pending.ts         # Deferral record: notify once when a release has waited too long
├── notify.ts          # Failure notifier: command (JSON on stdin) or https webhook
└── releaseDefaults.ts # Production dependencies (compile, build, consumeImageUp, Docker, control)
```

## Rules

- Identity is the Docker build-context digest, the same key the build cache
  uses. A change that does not reach the image never releases; one that does
  always does. The no-op path compiles and hashes, reads the ledger and one
  container inspection, and touches nothing else.
- Order is fixed and tested: build BEFORE drain (the drain window stays short),
  drain before deploy, ledger after the container settled on the built image
  and admission was confirmed. The deployment's home lock (the one `up` takes)
  is held from before the drain until the ledger is written.
- Only containers whose every runtime has a drain contract (`DRAINABLE_RUNTIMES`)
  are drained; anything else is refused unless `--no-drain`. Keep every effect behind `ReleaseDependencies` so the order stays
  a test, not a comment.
- Nothing here stops a turn. A drain that times out or is interrupted resumes
  admission and abandons the release (exit 75, deferred). `--no-drain` is the
  only path that deploys over running work, and it says so.
- The drain marker is written before the drain request, records the resolved
  Docker target (endpoint fingerprint), and is removed only once admission is
  open again. Every run resumes a stale marker first, through that target, even
  when there is nothing to release; an inspection error or changed endpoint
  keeps the marker.
- A ledger or marker that cannot be read is a refusal, never "assume stale".
- Pruning touches only `<repository>:r-*` tags, keeps the running image, one
  rollback and the tag being built, never removes an image any container uses,
  and never prunes build cache or volumes.
- Notifications carry a reason word from `RELEASE_FAILURE_REASONS` and a short
  path-scrubbed message. The full detail stays in `log.jsonl`. A notifier never
  throws into the release.
- The control token is read from the env file or process (same precedence as
  `up`) and reaches curl on stdin, never argv.
- Generic only: no organization, product or schedule names. Policy such as
  "release only between editions" belongs to the caller's timer.
