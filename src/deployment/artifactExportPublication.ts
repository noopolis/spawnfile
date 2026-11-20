import { link, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveOutputFilePaths } from "../filesystem/outputPaths.js";
import { SpawnfileError } from "../shared/index.js";
import type { ExportIndex } from "./artifactsExportTypes.js";
import { acquirePidLock } from "./pidLock.js";

export const EXPORT_INDEX_PATH = "spawnfile/export-index.json";
const LOCK_PATH = "spawnfile/.export.lock";

/** The adapter supplies data paths. The index, lock and staging area belong to Spawnfile. */
export const resolveArtifactOutputPaths = async (root: string, relativePaths: readonly string[]): Promise<string[]> => {
  if (relativePaths.some((filename) => typeof filename === "string" && filename.split("/")[0]?.startsWith(".spawnfile-export-"))) {
    throw new SpawnfileError("validation_error", "Artifact output overlaps the export staging area");
  }
  const paths = await resolveOutputFilePaths(root, [...relativePaths, EXPORT_INDEX_PATH, LOCK_PATH]);
  return paths.slice(0, relativePaths.length);
};

/** Replace indexed files as a batch. Keep the previous regular files until the index rename succeeds. */
export const publishArtifactFiles = async (destination: string, staging: string, index: ExportIndex): Promise<void> => {
  const relative = index.files.map((file) => file.path);
  const [lock] = await resolveOutputFilePaths(destination, [LOCK_PATH]);
  await mkdir(path.dirname(lock!), { recursive: true });
  const release = await acquirePidLock(lock!);
  try {
    const targets = await resolveArtifactOutputPaths(destination, relative);
    const sources = await resolveArtifactOutputPaths(staging, relative);
    targets.push(path.join(destination, EXPORT_INDEX_PATH));
    // The index and backup files live in a separate, private workspace.
    const transaction = await mkdtemp(path.join(path.dirname(staging), "transaction-"));
    const newIndex = path.join(transaction, "index.json");
    await writeFile(newIndex, `${JSON.stringify(index, null, 2)}\n`, { flag: "wx" });
    sources.push(newIndex);

    const backups: (string | undefined)[] = [];
    for (const [i, target] of targets.entries()) {
      await mkdir(path.dirname(target), { recursive: true });
      const backup = path.join(transaction, String(i));
      try {
        await link(target, backup);
        backups.push(backup);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        backups.push(undefined);
      }
    }

    let published = 0;
    try {
      for (const source of sources) {
        await rename(source, targets[published]!);
        published++;
      }
    } catch (error) {
      for (let i = published - 1; i >= 0; i--) {
        const backup = backups[i];
        if (backup) await rename(backup, targets[i]!);
        else await rm(targets[i]!, { force: true });
      }
      throw error;
    }
  } finally {
    await release();
  }
};
