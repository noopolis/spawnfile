# Dev Commands

This folder owns the `spawnfile dev` development deployment workflow.

`project.ts` contains the public command handlers used by the CLI (`dev up`,
`dev stop`). `docker.ts` contains Docker target resolution for a recorded dev
deployment. Keep workflow logic in this folder, not in CLI command handlers.

Dev mode is intentionally narrower than the normal lifecycle commands:

- It defaults to `.spawn-dev`.
- It targets project-backed Docker deployments.
- Its durable volumes are namespaced away from production's. `devUpProject`
  passes `DEV_DEPLOYMENT_LINEAGE_NAMESPACE` to `upProject`, which folds it into
  the deployment lineage that derived `exclusive-reattach` volume names hash
  (`src/compiler/deploymentLineage.ts`). Without it, `dev up` and a production
  `up` both compiled under the lineage `default` and attached the same host
  volumes. Author-declared volume names carry no lineage and cannot be
  namespaced, so `dev up` refuses to start on one unless
  `--allow-declared-volumes` is passed.
