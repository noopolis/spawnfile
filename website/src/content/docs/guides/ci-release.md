---
title: Release Images in CI
description: Build a Spawnfile project with `spawnfile build --release` in GitHub Actions and push the image to your own registry, getting back the pushed digest.
---

Build the organization image in CI rather than on the machine that runs it. The
Spawnfile repository ships a reusable GitHub Action that does one thing:

```text
checkout → spawnfile build --release <project> → docker push <image>:<tag> → digest
```

The host that runs the organization then only pulls `<image>@<digest>`.

## Usage

```yaml
name: release image

on:
  push:
    branches: [main]

jobs:
  image:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - id: release
        uses: noopolis/spawnfile/.github/actions/release-image@main
        with:
          project: .                      # directory holding the root Spawnfile
          image: docker.io/acme/my-org    # repository, no tag or digest
          username: ${{ secrets.REGISTRY_USERNAME }}
          password: ${{ secrets.REGISTRY_TOKEN }}

      - run: echo "pushed ${{ steps.release.outputs.image-reference }}"
```

Pin `@main` to a release tag or commit of `noopolis/spawnfile` once you depend
on it; the action builds the Spawnfile CLI from the same ref.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `project` | `.` | Project directory or Spawnfile path |
| `image` | required | Repository to push, e.g. `docker.io/acme/my-org`, `ghcr.io/acme/my-org` |
| `tag` | commit SHA | Tag to push |
| `registry` | host of `image` (`docker.io` when it has none) | Registry to log in to |
| `username` / `password` | required | Registry credentials, passed from the project's secrets |
| `spawnfile-version` | empty | Run a published `spawnfile` npm version instead of building the CLI from the action's ref |

## Outputs

| Output | Meaning |
| --- | --- |
| `digest` | Registry manifest digest of the pushed tag (`sha256:…`) |
| `image-reference` | `<image>@<digest>` — the immutable reference to deploy |
| `tag` | The tag that was pushed |

## What `--release` guarantees

`--release` builds workspace bundles only from clean committed inputs: a
checkout with uncommitted changes under the project fails the build instead of
baking them into the image. The action writes compile output to the runner's
temp directory so the checkout it verifies stays clean.

Credentials only reach `docker/login-action`; the action never prints them.
For a private Docker Hub repository, create an access token with read/write
scope for that repository and store it as the `password` secret.
