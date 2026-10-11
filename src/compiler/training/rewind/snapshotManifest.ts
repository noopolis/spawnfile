import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { trainingInstantSchema } from "../../../manifest/index.js";
import { inside, safeSegment, type History } from "./history.js";

const unsigned = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const nanos = z.string().regex(/^-?(?:0|[1-9][0-9]*)$/u);
const mode = z.number().int().min(0).max(0xffff);
const relativePath = z.string().min(1).refine((value) => !value.includes("\\") && !value.includes("\0")
  && !path.posix.isAbsolute(value) && !value.split("/").some((part) => !part || part === "." || part === ".."),
"Snapshot paths must be normalized relative POSIX paths");
const sourceIdentity = z.object({ dev: unsigned, ino: unsigned, size: unsigned, mtimeNs: nanos, ctimeNs: nanos, mode }).strict();
const entrySchema = z.object({ type: z.enum(["file", "directory", "symlink"]), mode, size: unsigned,
  source: sourceIdentity, target: z.string().refine((value) => !value.includes("\0")).optional() }).strict().superRefine((entry, ctx) => {
  if ((entry.type === "symlink") !== (entry.target !== undefined)) ctx.addIssue({ code: "custom", message: "Only snapshot symlinks require a target" });
  if (entry.mode !== entry.source.mode || entry.size !== entry.source.size) ctx.addIssue({ code: "custom", message: "Snapshot source identity disagrees with entry metadata" });
  const typeMode = { file: 0o100000, directory: 0o040000, symlink: 0o120000 }[entry.type];
  if ((entry.mode & 0o170000) !== typeMode) ctx.addIssue({ code: "custom", message: "Snapshot mode disagrees with entry type" });
});

/** Daimon's manifest records source identity, not the identity of retained/copied inodes. */
export const snapshotManifestSchema = z.object({ version: z.literal("noopolis.daimon.wake-moment.v1"), id: z.string().min(1),
  snapshot: z.string().min(1), started_at: trainingInstantSchema,
  sourcePath: z.string().refine((value) => path.posix.isAbsolute(value) && !value.includes("\0"), "Expected an absolute snapshot sourcePath"),
  entries: z.record(relativePath, entrySchema) }).strict().superRefine((manifest, ctx) => {
  for (const name of Object.keys(manifest.entries)) {
    for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) {
      if (manifest.entries[parent]?.type !== "directory") ctx.addIssue({ code: "custom", message: `Snapshot parent ${parent} must be a recorded directory` });
    }
  }
});
export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;

export const snapshotHistoryPath = (agentSlug: string, id: string, snapshot: string): string =>
  `recording/${safeSegment(agentSlug)}/snapshots/${safeSegment(id === "." || id === ".." ? id.replaceAll(".", "%2E") : id)}/${safeSegment(snapshot)}`;

export const readSnapshotManifest = async (history: History, relative: string, id: string, snapshot: string): Promise<SnapshotManifest | null> => {
  const bytes = await history.text(`${relative}.manifest.json`);
  if (bytes === null) return null;
  let manifest: SnapshotManifest;
  try { manifest = snapshotManifestSchema.parse(JSON.parse(bytes)); }
  catch (error) { throw new Error(`Invalid snapshot manifest ${relative}.manifest.json: ${error instanceof Error ? error.message : String(error)}`); }
  if (manifest.id !== id || manifest.snapshot !== snapshot) throw new Error(`Snapshot manifest identity mismatch at ${relative}.manifest.json`);
  return manifest;
};

interface TreeInspection {
  retained?: boolean;
  readBytes?: (relative: string) => Promise<Buffer>;
  expectedBytes?: (relative: string) => Promise<Buffer>;
}
/** No symlink traversal. A separate call inspects the copied tree, independently of the producer. */
export const snapshotTreeFindings = async (root: string, manifest: SnapshotManifest, options: TreeInspection = {}): Promise<string[]> => {
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
        // Recorder directories are deliberately 0700. Restore source modes while copying.
        const wantedMode = options.retained && type === "file" ? expected.mode & 0o777 : expected.mode & 0o7777;
        if (!(options.retained && type === "directory") && (Number(stat.mode) & 0o7777) !== wantedMode) findings.push(`Snapshot mode mismatch for ${name}`);
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
export const copySnapshotTree = async (history: History, relative: string, destination: string, manifest: SnapshotManifest): Promise<void> => {
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
