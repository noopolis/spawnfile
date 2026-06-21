# Dev Commands

This folder owns interactive development workflows that operate on already-running
Spawnfile deployments.

`project.ts` contains the public command handlers used by the CLI. `docker.ts`
contains Docker target resolution, copying, ownership fixes, and compile
architecture probing. Keep workflow logic in this folder, not in CLI command
handlers.

Dev mode is intentionally narrower than the normal lifecycle commands:

- It defaults to `.spawn-dev`.
- It targets project-backed Docker deployments.
- Hot apply currently supports Pi runtime agents one at a time.
- It mutates a running dev container without rebuilding or restarting it.
