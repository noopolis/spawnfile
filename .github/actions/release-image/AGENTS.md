# Release Image Action

Composite GitHub Action for project repositories: `spawnfile build --release`
→ push to the registry the project names → output the registry digest.
Documented in `website/src/content/docs/guides/ci-release.md`.

- `action.yml` — the action. By default it builds the Spawnfile CLI from the
  action's own ref (`github.action_path`), so a caller pinning the action ref
  pins the compiler too; `spawnfile-version` switches to a published npm CLI.
- Credentials arrive only as `username`/`password` inputs and flow only into
  `docker/login-action`. Never echo them or read `secrets.*` here.
- The digest output comes from the registry (`imagetools inspect`), not from
  local image metadata, so it is what a host will actually pull.
- `scripts/runtime-image-workflows.test.ts` pins this contract.
