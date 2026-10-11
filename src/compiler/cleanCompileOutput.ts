import path from "node:path";
import { readdir, rm } from "node:fs/promises";

/** Deployment records and histories are host state, not replaceable compile output. */
export const cleanCompileOutput = async (directory: string): Promise<void> => {
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) if (entry !== "deployments") {
    await rm(path.join(directory, entry), { recursive: true, force: true });
  }
};
