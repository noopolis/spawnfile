---
title: Releasing
description: Update a running organization only when its image changed, without killing a running agent turn.
---

`spawnfile release` is the command a host timer runs. It rebuilds and redeploys a detached deployment only when the image inputs changed, and drains running Daimon turns before replacing the container.

```bash
spawnfile release ./org \
  --deployment prod \
  --env-file /etc/org/deploy.env \
  --drain-timeout 30m \
  --notify-command /usr/local/bin/notify-operator
```

`deploy.env` must set `SPAWNFILE_DAIMON_CONTROL_TOKEN` so the release can drain the running runtime.

## What a run does

```text
compile → identity unchanged? → exit 0, nothing touched
        → build → drain → wait for running turns → deploy → settle → resume → record → prune
```

- **Identity** is the Docker build-context digest. A commit that does not change what goes into the image (for example data served from a volume) is not a release.
- **Drain** pauses admission: new wakes are answered `work-blocked` and retried by Moltnet, queued wakes stay queued, running turns finish. If they do not finish within `--drain-timeout`, admission resumes, nothing is deployed and the command exits `75`. Run it again later.
- **Deploy** uses image-mode `up`, so a candidate that does not become ready is rolled back to the previous container.
- **Prune** keeps the running image and one rollback (`spawnfile up <repository>:r-<id> --image --deployment prod` restores it) and removes older release images.

## Failure notification

Declare one notifier:

- `--notify-command /abs/path` runs with the notification JSON on stdin and `SPAWNFILE_RELEASE_REASON` / `SPAWNFILE_RELEASE_MESSAGE` in its environment.
- `--notify-webhook-env ALERT_URL` POSTs the JSON to the https URL in `$ALERT_URL`.

Every failure notifies with a fixed reason word (`build-failed`, `drain-failed`, `deploy-failed`, `health-failed`, `resume-failed`, ...). A deferred release notifies once when it has waited longer than `--notify-deferred-after` (default `24h`).

## Running on a timer

```ini
# release.service
[Service]
Type=oneshot
ExecStartPre=/usr/bin/git -C /srv/org pull --ff-only
ExecStart=/usr/local/bin/spawnfile release /srv/org --deployment prod --env-file /etc/org/deploy.env --notify-command /usr/local/bin/notify-operator
SuccessExitStatus=75
TimeoutStartSec=2h
```

`TimeoutStartSec` must cover build time, the drain timeout, and deploy. The ledger, log and deferral records live under `~/.spawnfile/releases/<deployment>/`. The full contract is in `specs/RELEASE.md`.
