# Local Evidence-Export Helper Guide

This folder owns Spawnfile's package-shipped local-development evidence-export
helper. It is a target setup facility, not a target-resource operation.

## Structure

- `helperProgram.mjs` is the image entrypoint source. It reads only the fixed
  `/spawnfile/evidence` mount and emits strict canonical USTAR to stdout.
- `copyAssets.mjs` copies that source beside the compiled modules for npm
  packaging.
- `recipe.ts` loads the shipped source, creates the fixed Dockerfile and
  canonical build context, and derives source identities.
- `preparedAuthority.ts` is the Spawnfile-home, fsynced private reservation
  journal for the opaque prepared-helper receipt. It is never a caller path.
- `preparedBuilder.ts` captures the immutable config ID emitted by its own
  package-asset build, then re-attests that ID without registry manifests,
  RepoDigests, or mutable tag adoption.
- `index.ts` is the folder barrel.

## Rules

- Never select an implicit or remote Docker context.
- Never push to or pull from a registry. The reviewed base image must already
  exist on the selected local daemon.
- Never adopt an image from a tag alone. Uncompleted reservations always build
  afresh and capture Docker's immutable build result; reuse requires an exact
  private completion plus immutable image/config inspection.
- The image declares exactly the fixed nonsecret
  `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`; null,
  duplicated, additional, or drifted environment entries fail re-attestation.
- Public callers receive only a versioned receipt and opaque handle. Context,
  daemon, base, recipe, reservation detail, and image config identities remain
  in the Spawnfile-owned private record.
- Keep stdout machine-readable. Helper failure diagnostics must not expose
  evidence paths or contents.
- The emitted evidence archive must remain byte-for-byte compatible with the
  strict parser in `../target/evidenceExportArchive.ts`.
