# Training preparation

Owns the v2 declaration, local pinned inputs, packaged image recipe and verified
build reuse before the existing container launcher. Never invoke a model, host
project script or sibling implementation. Project fixture meaning stays in the
installed integration. Credentials remain explicit runtime leaves, never image
inputs. Dry-run performs reads only; resume validates the preserved preparation.

`contract.ts` declares authoring and runtime receipts; `files.ts` safely seals
declared bytes; `image.ts` prepares/builds the recipe; `inputs.ts` snapshots Git;
`contextModes.ts` normalizes staged build-context modes/times; `daimonParent.ts`
binds the declared native parent to the attested Daimon runtime identity;
`prepare.ts` combines those operations. Keep tests adjacent and files below 400
lines. Source/lock/recipe mutation must invalidate cache and exact resume.

- Built preparations seal original image bytes in a protected witness for explicit
  captured-work repair. Optional compiler selects a separate full pinned native
  compiler distribution; the current package still owns launch/auth operations.
- Exclude explicit generated Python coverage/cache files, not arbitrary dotfiles.
- `scratch.ts` claims the private preparation directory. A launch that aborts
  past staging leaves it behind; a leftover from the *same* preparation digest
  is reclaimed and re-staged, anything else is left untouched and reported by
  name with the command that clears it. It must never delete a directory it
  cannot prove is a leftover of this exact preparation.
- Repair transport/compatibility lives in sibling `repair/`; it never changes
  candidate, criteria or checkpoint semantics owned by Paideia.
- `daimonParent.ts` closes the two-pointer hole between `image.build.nativeImage`
  and `SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY`. They are never the same digest —
  `runtime-images/daimon/Dockerfile` ends in `FROM scratch`, so the identity can
  only attest a scratch image that a runnable native parent copies
  `/opt/spawnfile/runtime-installs/daimon` out of — so the binding is by content.
  Host-side, before any Docker call and before `--dry-run` returns, it applies the
  existing `manifest_sha256` contract pin to training runs (which never applied it
  at all before), refuses an architecture disagreement, and refuses a loopback
  registry parent declared with no identity. The digest equality itself lives
  inside the image, so the guard is injected as the first instruction of the
  `${NATIVE_IMAGE}` stage and names both files and both values when it refuses;
  `src/runtime/container.ts` verifies the same receipt for a compiled
  organization image. The recipe text is part of the plan digest, so a rotated
  identity can never be served from an existing training image.
