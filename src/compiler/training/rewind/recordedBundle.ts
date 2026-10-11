import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { validateWorkspaceBundleTar } from "../../workspaceBundleArtifacts.js";
import { recordedSha256Schema } from "./contract.js";
import { extractBundleBytes } from "./gitTree.js";
import type { History } from "./history.js";

const recordedBytes = async (history: History | undefined, sha256: string): Promise<Buffer | null> => {
  recordedSha256Schema.parse(sha256);
  const bytes = await history?.bytes(`bundles/${sha256.slice(7)}.tar`);
  if (!bytes || bytes.length > 536_870_912 || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== sha256) return null;
  return bytes;
};

export const materializeRecordedBundle = async (history: History | undefined, sha256: string, destination: string): Promise<boolean> => {
  const bytes = await recordedBytes(history, sha256);
  if (!bytes) return false;
  await extractBundleBytes(bytes, destination);
  return true;
};

/** Acceptance reopens the digest-pinned archive and compares disk bytes, without trusting producer metadata. */
export const verifyRecordedBundle = async (history: History | undefined, sha256: string, directory: string): Promise<void> => {
  const bytes = await recordedBytes(history, sha256);
  if (!bytes) throw new Error(`Recorded bundle ${sha256} could not be reproduced`);
  validateWorkspaceBundleTar(bytes);
  const text = (field: Buffer) => field.toString("utf8").replace(/\0.*$/su, "");
  const files = new Map<string, { bytes: Buffer; executable: boolean }>(), directories = new Set<string>();
  for (let offset = 0; offset < bytes.length && !bytes.subarray(offset, offset + 512).every((byte) => byte === 0);) {
    const header = bytes.subarray(offset, offset + 512), prefix = text(header.subarray(345, 500));
    const name = `${prefix ? `${prefix}/` : ""}${text(header.subarray(0, 100))}`.replace(/\/$/u, "");
    const size = Number.parseInt(text(header.subarray(124, 136)).trim(), 8);
    for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) directories.add(parent);
    if (header[156] === 53) directories.add(name);
    else files.set(name, { bytes: bytes.subarray(offset + 512, offset + 512 + size), executable: Boolean(Number.parseInt(text(header.subarray(100, 108)).trim(), 8) & 0o111) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const walk = async (folder: string, prefix = ""): Promise<void> => {
    for (const name of await readdir(folder)) {
      const relative = prefix ? `${prefix}/${name}` : name, full = path.join(folder, name), stats = await lstat(full);
      if (stats.isDirectory() && directories.delete(relative)) await walk(full, relative);
      else {
        const expected = files.get(relative);
        if (!stats.isFile() || !expected || Boolean(stats.mode & 0o111) !== expected.executable || !(await readFile(full)).equals(expected.bytes)) {
          throw new Error(`Recorded bundle entry mismatch: ${relative}`);
        }
        files.delete(relative);
      }
    }
  };
  await walk(directory);
  if (files.size || directories.size) throw new Error(`Missing recorded bundle entries: ${[...files.keys(), ...directories].join(", ")}`);
};
