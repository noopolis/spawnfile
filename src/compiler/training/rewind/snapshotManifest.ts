import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { retainedSnapshotMode } from "../../../runtime/legacyRecording.generated.js";
import { inside, type History } from "./history.js";

export {
  isPartialSnapshot, readSnapshotManifest, snapshotHistoryPath, snapshotManifestSchema, wakeHistoryPath
} from "../../../runtime/legacyRecording.generated.js";
export type { SnapshotManifest } from "../../../runtime/legacyRecording.generated.js";

/** Metadata needed to verify and copy a contained snapshot tree, independent of its archive codec. */
interface SnapshotTree {
  entries: Record<string, { type: "file" | "directory" | "symlink"; mode: number; size: string; target?: string }>;
}

interface TreeInspection {
  retained?: boolean;
  readBytes?: (relative: string) => Promise<Buffer>;
  expectedBytes?: (relative: string) => Promise<Buffer>;
}
/** No symlink traversal. A separate call inspects the copied tree, independently of the producer. */
export const snapshotTreeFindings = async (root: string, manifest: SnapshotTree, options: TreeInspection = {}): Promise<string[]> => {
  if (!(await lstat(root)).isDirectory()) throw new Error("Snapshot tree must be a real directory");
  const findings: string[] = [], found = new Set<string>();
  const visit = async (relative: string): Promise<void> => {
    for (const leaf of (await readdir(path.join(root, relative))).sort()) {
      const name = relative ? `${relative}/${leaf}` : leaf, file = path.join(root, name);
      const stat = await lstat(file, { bigint: true }), expected = manifest.entries[name];
      found.add(name);
      const type = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "special";
      if (!expected) findings.push(`Unexpected snapshot entry ${name}`);
      else if (type !== expected.type) findings.push(`Snapshot type mismatch for ${name}`);
      else {
        const wantedMode = options.retained ? retainedSnapshotMode(expected.type, expected.mode) : expected.mode & 0o7777;
        if (wantedMode !== null && (Number(stat.mode) & 0o7777) !== wantedMode) findings.push(`Snapshot mode mismatch for ${name}`);
        // Directory inode sizes describe source filesystem bookkeeping, not tree content.
        if (type !== "directory" && stat.size.toString() !== expected.size) findings.push(`Snapshot size mismatch for ${name}`);
        if (type === "symlink" && await readlink(file) !== expected.target) findings.push(`Snapshot symlink target mismatch for ${name}`);
        if (type === "file" && options.expectedBytes) {
          const actual = options.readBytes ? await options.readBytes(name) : await readFile(file);
          const original = await options.expectedBytes(name);
          const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
          if (digest(actual) !== digest(original)) findings.push(`Snapshot digest mismatch for ${name}`);
        }
      }
      if (type === "directory") await visit(name);
    }
  };
  await visit("");
  for (const name of Object.keys(manifest.entries)) if (!found.has(name)) findings.push(`Missing snapshot entry ${name}`);
  return findings;
};

export const snapshotBytes = async (history: History, relative: string, name: string): Promise<Buffer> => {
  const bytes = await history.bytes(`${relative}/${name}`);
  if (bytes === null) throw new Error(`Missing snapshot entry ${name}`);
  return bytes;
};

/** Retained files may be hard-linked to each other; bundle files are always new copies. */
export const copySnapshotTree = async (history: History, relative: string, destination: string, manifest: SnapshotTree): Promise<void> => {
  const source = await history.path(relative);
  if (!source) throw new Error(`Missing snapshot tree ${relative}`);
  const findings = await snapshotTreeFindings(source, manifest, { retained: true });
  if (findings.length) throw new Error(findings.join("; "));
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const entries = Object.entries(manifest.entries).sort(([a], [b]) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  for (const [name, entry] of entries) {
    const target = path.join(destination, name);
    if (entry.type === "directory") await mkdir(target, { mode: 0o700 });
    else if (entry.type === "symlink") {
      if (path.isAbsolute(entry.target!) || !inside(destination, path.resolve(path.dirname(target), entry.target!))) {
        throw new Error(`Snapshot symlink escapes root: ${name}`);
      }
      await symlink(entry.target!, target);
    } else {
      await writeFile(target, await snapshotBytes(history, relative, name), { flag: "wx" });
      await chmod(target, entry.mode & 0o7777);
    }
  }
  for (const [name, entry] of entries.reverse()) if (entry.type === "directory") await chmod(path.join(destination, name), entry.mode & 0o7777);
  const copied = await snapshotTreeFindings(destination, manifest, { expectedBytes: (name) => snapshotBytes(history, relative, name) });
  if (copied.length) throw new Error(copied.join("; "));
};
