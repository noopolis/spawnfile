import { createHash } from "node:crypto";

/**
 * Host-stable name for state that must be reattached, never cloned, across
 * run and deployment identities. The mount id is compiler-owned and the
 * digest prevents normalization collisions.
 */
export const createExclusiveReattachVolumeName = (lineage: string, mountId: string): string => {
  const safe = mountId
    .replace(/[^A-Za-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "realm";
  const digest = createHash("sha256").update(lineage, "utf8").update("\0").update(mountId, "utf8").digest("hex").slice(0, 16);
  return `spawnfile-exclusive-${safe}-${digest}`;
};
