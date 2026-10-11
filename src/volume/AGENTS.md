# Volume Guide

This folder owns host-fed volumes: a `kind: volume` resource that declares `feed`
gets its content from a host directory or a git ref, copied into the running
volume by atomic swap. Nothing about the content enters the image, so a content
change never triggers a build. The compiled volume is identical with or without
`feed`; everything here runs on the host (`spawnfile volume refresh|verify`).

## Structure

```text
src/volume/
├── index.ts           # Barrel
├── feedTarget.ts      # FeedTarget (everything a refresh needs) and its defaults
├── feedProject.ts     # Project + resource id -> FeedTarget; docker volume host path
├── feedSource.ts      # Directory and git sources: content-addressed revision, staging copy
├── feedPrepare.ts     # include + prepare in staging, composed revision, digest-verified prepare cache
├── feedRef.ts         # Moving refs (template, command, fallback), dated paths, waiting, and the period freeze
├── feedLayout.ts      # Every rule about what may touch the volume: lstat guards, freeze, land, link swap
├── feedManifest.ts    # Land-time manifest outside the volume; every file hashed on every check
├── feedRecord.ts      # Host record (outside) and identity record (inside the volume)
├── feedLandings.ts    # Recording-only landing history, retention and at-instant lookup
├── feedLand.ts        # Stage -> validation hook -> freeze -> one rename in -> current swap -> record -> GC
├── feedRefresh.ts     # Refresh/verify orchestration, healing, heal limit, under the lock
├── feedVerify.ts      # Integrity sweep against the host record; never throws
├── feedLock.ts        # O_EXCL single-writer lock; stale reclaim only for provably dead holders
└── feedTestKit.ts     # Temp-dir fixture shaped like a container-initialized volume
```

## Volume layout

```text
<volume>/.spawnfile-resource-identity   container's sentinel; never touched
<volume>/.spawnfile-feed.json           identity record agents read (an output, never an input)
<volume>/current -> trees/<name>        the only path agents read content through
<volume>/trees/<revision>[.<gen>]/      frozen content, never rewritten or replaced in place;
                                        a re-land lands as a new generation beside the drifted tree
<state>/landed.json, manifests/, staging/, trash/, lock, prepared/   host state, outside the volume
<state>/landings.jsonl                 recording-only history, independent of tree retirement
```

## Rules

- Content enters the volume through exactly one rename(2), becomes visible through
  one rename(2) of `current`, and leaves through one rename(2). Copies, deletes and
  recursive mode/owner changes happen only outside the volume.
- Never take a decision from a name inside the volume. lstat every path before
  touching it; refuse a symlink or file where a host directory belongs.
- Never delete or move a name the host did not write. Report it, with the command
  that clears it.
- Never touch the volume root's mode or the container's sentinel; refuse to land
  into a volume no container has initialized.
- Host state stays outside the volume and on its filesystem (same-device check).
- Domain rules about what content must contain stay with the organization, as the
  declared `validate` command. Keep this folder generic.
- Retirement follows the host record's serving order, never filesystem mtimes.
- Landing history is enabled only for feeds consumed by a recording compiled agent. Its retention
  is the maximum consumer `record.keep` (default 30d); no recording means no log reads or writes.
  Append and fsync only after `landed.json` succeeds, including generations, retained-tree re-points,
  link repairs and provenance/period adoption. Sample `switching_at` immediately before the current
  rename; `landed_at` stays the identity instant. Both include milliseconds. Lookup inside the
  inclusive transition window returns the entry with `ambiguous: true`.
  Before every host-record replacement, reconcile the already-read predecessor against the last entry.
  The host record embeds the landing source/keep so failed appends survive source changes.
  A clean refresh also seeds history when recording is enabled later. Preserve original
  instants; refuse replacement when reconciliation fails. File fsync and directory fsync
  after rename must complete before log append; a matching tail is reconciled only after fsync of
  the log and its directory. Pruning syncs its rename directory. Recording off retains the original
  host-record bytes and filesystem calls, except to reconcile a predecessor that recorded earlier.
  Keep the newest entry at or before the retention cutoff as the state at the window's start.
  Invalid JSONL lines are reported beside valid entries; readers never silently trust them.
- A revision is decided before anything runs: with `include`/`prepare` it is composed from the
  source revision, include digests and the prepare recipe. Prepare output is verified by the
  land-time manifest, not by the revision.
- The freeze and the wait are decided from the host record's period and the host clock only.
  A held volume (frozen or waiting) heals from the commit it serves and never advances.
- Known limits, stated so nobody overclaims them: a reader that holds a descriptor
  or working directory inside a tree that is later retired (beyond `keep`) can see
  it deleted; and path checks are lstat-then-act, not descriptor-relative (Node has
  no openat), so an agent racing a host operation on a tree it can still reach is
  detected by the next verify rather than prevented.
- `feedAtomicity.test.ts` and `feedLock.test.ts` are the guarantees. A change that
  weakens a rename, a link swap or the lock must turn one of them red.
