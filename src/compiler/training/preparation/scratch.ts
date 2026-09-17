import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";

/**
 * Claims the private preparation scratch directory for one launch.
 *
 * A launch that fails anywhere past staging — a failed build, a container that
 * aborted in its entrypoint — leaves this directory behind, and the next
 * attempt used to die on `EEXIST: mkdir '.spawnfile-training-preparation-…'`
 * before it could report anything useful. A live P8 run lost its second attempt
 * to exactly that.
 *
 * Leftovers from the *same* preparation are reclaimed: `state.json` records the
 * preparation digest, which pins the config, every input identity, the image
 * plan and the canonical source digest, so a matching one can only have staged
 * the same bytes and nothing is lost by staging them again (the image is
 * content-addressed and resolves from its tag). Anything else — a different
 * digest, or a run that aborted before it wrote its state — is left untouched
 * and reported by name, because only the operator can know whether it is
 * wanted or whether another launch is still using it.
 */
export const claimTrainingPreparationScratch = async (
  staging: string,
  digest: string,
  notify: (line: string) => void
): Promise<void> => {
  try {
    await mkdir(staging, { mode: 0o700 });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(staging);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(staging) !== staging) {
    throw Error(`Training preparation scratch ${staging} is not a canonical directory; remove it and retry`);
  }
  let previous: { digest?: unknown } | undefined;
  try { previous = JSON.parse(await readFile(`${staging}/state.json`, "utf8")) as { digest?: unknown }; }
  catch { previous = undefined; }
  if (previous?.digest !== digest) {
    throw Error(previous === undefined
      ? `Training preparation scratch ${staging} is left over from an interrupted launch that never recorded its identity; remove it to retry: rm -rf ${JSON.stringify(staging)}`
      : `Training preparation scratch ${staging} belongs to a different preparation (${String(previous.digest)}); remove it to retry: rm -rf ${JSON.stringify(staging)}`);
  }
  notify(`Reusing the preparation scratch left by an earlier launch of this exact preparation: ${staging}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { mode: 0o700 });
};
