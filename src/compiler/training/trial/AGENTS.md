# Shared production trial services

- `project.ts` projects the subject's real project into a one-agent manifest
  with team inheritance and source-relative paths intact. Trial projects drop
  other members, networks, external participants, schedules and nested training.
- `docker.ts` runs bounded Docker commands and readiness polling.
- `evidence.ts` streams container logs and diagnostic archives onto the
  operator's disk with byte-preserving secret masking. Bounds, refused paths,
  and capture failures go into the evidence manifest.
- `realmLock.ts` uses a SQLite lock per training profile, keeps a durable
  cleanup note, and recovers resources left by a dead holder.
- `realmTurns.ts` grants exclusive turns to containers using the same login
  realm. `judgePool.ts` queues requests for warm judge containers.
- `types.ts` describes the trial handles and wake results used by pooling and
  caching. `cache/` stores and replays measured trials and judgments.

Native trial boot, wake, gateway, judging and login are owned by the selected
runtime. The Daimon implementation lives in `src/runtime/daimon/training/trial/`.
