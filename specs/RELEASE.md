# Spawnfile Drained Release v0.1

`spawnfile release` updates a running detached deployment from its project.
It builds and deploys only when the image inputs changed, and it never kills a
running agent turn.

## Command

```bash
spawnfile release <project> --deployment <name> --runtime-env-file <file> \
  [--drain-timeout 30m] [--no-drain] [--force] [--dev-inputs] \
  [--notify-command <absolute path> | --notify-webhook-env <ENV_NAME>] \
  [--notify-deferred-after 24h] [--image-repository <name>] [--context <docker context>]
```

Exit codes: `0` released or unchanged, `75` deferred (try again later),
`1` failed, `2` usage error.

## Order

```text
lock → resume stale drain → compile → identity
  → unchanged? exit 0, nothing else touched
  → build → drain → wait for running turns (bounded)
      timeout: resume, record deferral, exit 75 (nothing deployed)
  → deploy (candidate + rollback, as `up --image`) → settle → confirm admission
  → record ledger → prune images
```

1. **Identity.** The release compiles the project (`--release` bundle identity
   by default: workspace bundles from clean committed inputs) and takes the
   Docker build-context digest as its identity. It is a function of everything
   the image is built from, including target architecture.
2. **Unchanged.** If the ledger's identity equals the new identity AND the
   deployment's container is running the ledger's image id, the release exits
   `0` without building, draining or deploying. A container running anything
   else (a hand deploy, a stopped container) is not "unchanged".
3. **Build** happens before the drain, so admission is paused only for the
   deploy itself. Images are tagged `<repository>:r-<first 12 hex of identity>`;
   `<repository>` defaults to `spawnfile-<project directory>`. An image that
   already exists for that identity is reused.
4. **Drain.** The deployment's home lock (the lock `up` takes) is held from
   here until the ledger is written. When a container is running, every
   runtime in its image (read from the embedded distribution report) must have
   a drain contract — today only `daimon` — or the release refuses (`blocked`)
   unless `--no-drain`. The release then calls Daimon's control
   API (`POST /v2/drain`, contract `operatorDrain` in the vendored Daimon
   manifest): new wakes answer `work-blocked` (Moltnet retries them), queued
   wakes stay queued, running turns finish. It then polls
   `GET /v2/availability` until `drain.state` is `drained`.
   - The control token is `SPAWNFILE_DAIMON_CONTROL_TOKEN`, read from the
     process environment or `--runtime-env-file` (same precedence as `up`). Without it
     a release that must drain refuses before building.
   - Calls run in an ephemeral helper from the running image inside the
     container's network namespace; the token reaches curl on stdin.
   - A runtime without the drain route (404), a rejected token or an
     unreachable control plane fails the release (`drain-failed`) and resumes.
   - On `--drain-timeout` the release resumes admission, does not deploy and
     exits `75`. Nothing in the release stops a turn.
   - `--no-drain` deploys without draining and kills in-flight turns. It
     exists for runtimes without a drain API and is never the default.
5. **Drain marker.** `drain.json` is written before the drain request, names
   the container and the resolved Docker target with its endpoint fingerprint,
   and is removed once admission is open again. Every run first resumes a
   container a killed release left drained, through that target, even when it
   has nothing to release. A changed endpoint or an inspection error keeps the
   marker and fails (`resume-failed`). Before deploying, the drained container
   is inspected again: a replaced or restarted container (which admits again),
   an inspection error or an interruption resumes it and aborts.
6. **Deploy** reuses image-mode `up`: the previous container is moved aside,
   the candidate must become ready, and a failed candidate restores the
   previous container. Durable state lives on named volumes and survives. After
   a failed deploy the release resumes whatever container holds the name.
7. **Settle.** Ready is not settled: the release polls until the container is
   running, healthy (or has no healthcheck) and its restart count is unchanged
   for three consecutive polls, and it must run the image this release built.
8. **Confirm admission** with `POST /v2/resume` against the new container. It
   proves the control token works for the next release.
9. **Ledger** is written only now, because it claims "this identity is
   running". A ledger that cannot be written fails the release
   (`ledger-failed`): until it is fixed every run redeploys.
10. **Prune.** Keeps the running image, one rollback and the tag being built;
    removes older `<repository>:r-*` tags not used by any container. Never
    touches other tags, volumes or build cache.

## Release store

Under `<SPAWNFILE_HOME>/releases/<deployment>/` (directory `0700`, files
`0600`):

| File | Meaning |
| --- | --- |
| `ledger.json` | `spawnfile.release-ledger.v1`: identity, image id/tag, previous tag, compile fingerprint, timings (compile, build, drain, deploy, total) |
| `log.jsonl` | `spawnfile.release-log.v1` lines for releases, failures, deferrals and notification results. No-ops write nothing. |
| `pending.json` | first instant the current identity was deferred, and whether that was notified |
| `drain.json` | present only while a container may be drained by a release |
| `.lock` | one release per deployment; published with its owner already inside, reclaimed when that process is gone |

A ledger, pending record or marker that exists and cannot be read is a refusal
or an immediate notification, never treated as absent.

## Failure notification

One notifier may be declared:

- `--notify-command <absolute path>`: executed without a shell, with the
  notification JSON on stdin and `SPAWNFILE_RELEASE_REASON`,
  `SPAWNFILE_RELEASE_DEPLOYMENT`, `SPAWNFILE_RELEASE_MESSAGE`,
  `SPAWNFILE_RELEASE_IDENTITY` in its environment. Exit `0` is delivered.
- `--notify-webhook-env <NAME>`: the URL is read from that environment
  variable (https, or http on loopback only) and receives a JSON POST; three
  attempts with backoff.

The notification is `spawnfile.release-notification.v1`:
`{reason, deployment, host, identity, message, at}`. `reason` is one of
`blocked`, `build-failed`, `drain-failed`, `deploy-failed`, `health-failed`,
`resume-failed`, `ledger-failed`, `interrupted`, `release-deferred`. `message`
is at most 500 characters with filesystem paths replaced by `<path>`.

Every failure notifies. A deferral notifies once per pending identity after it
has waited `--notify-deferred-after`, or immediately when the pending record is
unreadable or unwritable. The result of every notification is appended to
`log.jsonl`, so an undelivered message still exists on disk.

## Scheduling

The release decides whether there is anything to do, so a caller may run it
on a timer. Fetching the source checkout (for example `git pull --ff-only`
before the release) and any domain policy about when releases are welcome
belong to the caller. A timer unit's start timeout must exceed build time plus
`--drain-timeout` plus deploy and settle time.

## Boundaries

Draining pauses admission only for the duration of an update; it never selects,
wakes or stops an agent. It is organization lifecycle (Spawnfile "update")
under `ECOSYSTEM_RUNTIME_BOUNDARIES.md`, uses the runtime's published control
contract, and carries no provider traffic.
