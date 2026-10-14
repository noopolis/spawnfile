import path from "node:path";
import { hostname } from "node:os";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";

/**
 * The receipt binds identity AND the owning process before staging starts.
 * A matching digest alone never permits deletion. Unknown/remote/reused PIDs
 * fail closed; only ESRCH on this host proves that a writer has stopped.
 */
export const claimTrainingPreparationScratch = async (
  staging: string,
  digest: string,
  notify: (line: string) => void,
  mode: "fresh" | "resume" = "fresh"
): Promise<void> => {
  const recordOwner = (flag = "wx") => writeFile(path.join(staging, "owner.json"),
    JSON.stringify({ digest, host: hostname(), pid: process.pid }), { flag, mode: 0o600 });

  // This guard lives outside scratch so removal/recreation cannot drop the
  // exclusion barrier. Never break a stranded guard automatically: its absence
  // of a receipt cannot establish that its holder stopped.
  const guard = `${staging}.reclaim`;
  try { await mkdir(guard, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw Error(`Training preparation scratch recovery is already claimed: ${guard}; if no preparation is running, remove that guard and retry`);
  }
  try {
    if (mode === "fresh") {
      let created = false;
      try { await mkdir(staging, { mode: 0o700 }); created = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if (created) { await recordOwner(); return; }
    }
    // Re-read under exclusion, never delete based on an earlier observation.
    await assertAbandonedScratch(staging, digest, mode === "resume");
    if (mode === "resume") {
      // Claim before validating or reading snapshots: fresh recovery must see
      // this live process rather than the stopped original preparer.
      await recordOwner("w");
      return;
    }
    notify(`Reusing the preparation scratch left by an earlier launch of this exact preparation: ${staging}`);
    await removeTrainingPreparationScratch(staging);
    await mkdir(staging, { mode: 0o700 });
    await recordOwner();
  } finally { await rm(guard, { recursive: true }); }
};

const assertAbandonedScratch = async (staging: string, digest: string, resume: boolean): Promise<void> => {
  const info = await lstat(staging);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(staging) !== staging) {
    throw Error(`Training preparation scratch ${staging} is not a canonical directory; remove it and retry`);
  }
  let previous: { digest?: unknown } | undefined;
  try { previous = JSON.parse(await readFile(`${staging}/state.json`, "utf8")) as { digest?: unknown }; }
  catch {
    try { previous = JSON.parse(await readFile(path.join(staging, "owner.json"), "utf8")) as { digest?: unknown }; }
    catch { previous = undefined; }
  }
  if (previous?.digest !== digest) {
    if (resume) throw Error("Training preparation changed; exact resume rejected");
    throw Error(previous === undefined
      ? `Training preparation scratch ${staging} is left over from an interrupted launch that never recorded its identity; remove it to retry: rm -rf ${JSON.stringify(staging)}`
      : `Training preparation scratch ${staging} belongs to a different preparation (${String(previous.digest)}); remove it to retry: rm -rf ${JSON.stringify(staging)}`);
  }
  let owner: { digest?: unknown; host?: unknown; pid?: unknown } | undefined;
  try { owner = JSON.parse(await readFile(path.join(staging, "owner.json"), "utf8")); } catch { /* Unknown ownership fails closed. */ }
  if (owner?.digest !== digest || owner.host !== hostname() || typeof owner.pid !== "number" ||
    !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    throw Error(`Training preparation scratch ${staging} has no verifiable local owner; cannot prove its previous launch stopped`);
  }
  // Revalidation by the owning process is idempotent; other live owners refuse.
  if (resume && owner.pid === process.pid) return;
  let stopped = false;
  try { process.kill(owner.pid, 0); }
  catch (error) { stopped = (error as NodeJS.ErrnoException).code === "ESRCH"; }
  if (!stopped) throw Error(`Training preparation scratch ${staging} still has an active or unverifiable owner (${owner.pid}); retry after it stops`);
};

/** Make sealed directories removable without following input links out of owned scratch. */
export const removeTrainingPreparationScratch = async (staging: string): Promise<void> => {
  const writable = async (entry: string): Promise<void> => {
    const info = await lstat(entry);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    await chmod(entry, (info.mode & 0o777) | 0o700);
    for (const child of await readdir(entry)) await writable(path.join(entry, child));
  };
  await writable(staging);
  await rm(staging, { recursive: true, force: true });
};
