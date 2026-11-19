# External adapter fixture

This package consumes the public adapter API as a third party would. Its Dockerfile builds a disposable local fixture image. The harness starts without credentials and replies only on its isolated loopback test network. Keep it independent of private Spawnfile modules.

`Teamfile` is the packed Docker proof manifest. Keep its rooms, DMs, and readiness path in sync with `scripts/verify-external-acp-docker.ts`. The proof assigns fresh image tags and state volumes for each run.
