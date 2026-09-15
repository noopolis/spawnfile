# Experiment Storage

Owns local immutable artifacts, run/evaluation identities, append-only journals and
read-only replay. Public API: openExperimentStore in `index.ts`; contracts in types.ts.
There are no subject, judge, optimizer, browser or deployment calls in this module.

- createRun freezes dataset role, candidate/dataset/plan identity and optional protected
  metadata. Blob references bind stored visibility and run identity; caller-supplied
  reference fields cannot weaken permissions. Global blob bytes deduplicate by digest.
- ReadAccess comes from a trusted host, never request JSON. Optimizers cannot read
  validation/test data. Test access requires the stored candidate identity in an
  authorized frozen set and a test/released-replay phase. Viewer test results require
  explicit release. Raw evidence is operator-only; metadata is evaluator/operator-only.
- Viewer and optimizer projections omit protected metadata and hidden events/results.
  Evaluations default to evaluator-only. Callers must explicitly choose public
  visibility for approved projections. Subject-written
  data does not author ACLs, run manifests or access contexts.
- Published blobs/manifests/results are immutable. Stage writes, sync, then publish
  with a no-overwrite link and sync the parent directory before returning. New
  parent directories and first journal entries are synced as well. Conflicting reuse of an identity fails. Temporary files
  from interrupted writes are not published evidence; replay ignores them.
- Journal writes serialize within the process and take an exclusive file lock across
  processes. A busy/stale lock is explicit infrastructure failure, not guessed recovery.
  Exact duplicate events are idempotent; conflicting duplicates fail.
- Journal sequence is persistence order, never an invented native causal relation.
  Native ordering stays in payload. Digests and contiguous persistence sequences are
  verified during replay. Torn final lines are reported, never silently repaired or
  interpreted as observations; appending requires explicit operator recovery first.
- Historical scores never change: rescoring uses a new result ID. Replay only reads;
  it never generates cognition, writes scores or repairs historical data.
- Store paths must be host-controlled/protected from subject access. Files use private
  modes and reject symlinks; this is not an OS sandbox against unrelated processes.
  Per-file storage and journal size is bounded at 64 MiB. Keep generated stores out of Git.

Tests live beside source and cover actual persisted effects, forged ACL references,
corruption, interrupted tails, immutable history, native identity retention, concurrent
writes and phase access. Target this module during edits; preserve inherited 90% per-file
coverage, TypeScript and ESLint gates. Full project checks belong to the final boundary.

`listBlobs` exposes only validated content-addressed reference metadata permitted by
the same run, audience, phase and frozen-candidate policy as `readBlob`. It does not
provide a way to enumerate sealed test evidence during optimization. Measurement
repair copies verified development captures through these public store methods.
