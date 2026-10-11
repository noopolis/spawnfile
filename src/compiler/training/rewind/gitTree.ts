import { lstat, mkdir, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { compileExcludePatterns } from "../../workspaceBundleFiles.js";
import { validateWorkspaceBundleTar } from "../../workspaceBundleArtifacts.js";
import { rewindGit } from "./gitProcess.js";

export const safeCommittedPath = (value: string): string => {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0") || value.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new Error(`Unsafe committed path: ${value}`);
  }
  return value;
};

/** Never traverse a symlink left by an earlier generated input while merging trees. */
const parentDirectory = async (root: string, relative: string): Promise<void> => {
  let directory = root;
  for (const segment of relative.split("/").slice(0, -1)) {
    directory = path.join(directory, segment);
    const existing = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (existing && !existing.isDirectory()) throw new Error(`Committed entry traverses a non-directory: ${relative}`);
    if (!existing) await mkdir(directory);
  }
};

export interface ExportTreeOptions { root?: string; exclude?: readonly string[]; paths?: readonly string[]; prefix?: string; mergeIdentical?: boolean }

/** Materialize blobs by object id, without invoking archive attributes, filters or extraction tools. */
export const exportGitTree = async (repo: string, commit: string, destination: string, options: ExportTreeOptions = {}): Promise<void> => {
  const root = options.root && options.root !== "." ? safeCommittedPath(options.root.replace(/\/$/u, "")) : "";
  const tree = root ? `${commit}:${root}` : `${commit}^{tree}`;
  if ((await rewindGit(repo, ["cat-file", "-t", tree])).toString().trim() !== "tree") throw new Error(`Bundle root ${root || "."} is not a tree at ${commit}`);
  const entries = (await rewindGit(repo, ["ls-tree", "-rz", tree])).toString("utf8").split("\0").filter(Boolean);
  const excluded = compileExcludePatterns(options.exclude);
  const prefix = options.prefix ? safeCommittedPath(options.prefix) : "";
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const tab = entry.indexOf("\t"), name = safeCommittedPath(entry.slice(tab + 1));
    const [mode, kind, oid] = entry.slice(0, tab).split(" ");
    if (excluded(name) || (options.paths && !options.paths.some((selected) => name === selected || name.startsWith(`${selected}/`)))) continue;
    if (kind !== "blob" || !["100644", "100755", "120000"].includes(mode!)) throw new Error(`Committed path ${name} is not a supported file or symlink (submodules need their own history)`);
    const target = path.join(destination, prefix, name), bytes = await rewindGit(repo, ["cat-file", "blob", oid!]);
    await parentDirectory(destination, [prefix, name].filter(Boolean).join("/"));
    if (options.mergeIdentical) {
      const present = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (present) {
        const identical = mode === "120000" ? present.isSymbolicLink() && await readlink(target) === bytes.toString("utf8")
          : present.isFile() && (present.mode & 0o111 ? "100755" : "100644") === mode && (await readFile(target)).equals(bytes);
        if (!identical) throw new Error(`Conflicting generated bundle inputs at ${name}`);
        continue;
      }
    }
    if (mode === "120000") await symlink(bytes.toString("utf8"), target);
    else await writeFile(target, bytes, { flag: "wx", mode: mode === "100755" ? 0o755 : 0o644 });
  }
};

/** Overrides use validated local ustar bytes, never tar commands or the network. */
export const extractOverrideBundle = async (file: string, destination: string, expected?: string): Promise<void> => {
  const info = await stat(file);
  if (!info.isFile() || info.size > 536_870_912) throw new Error("Override bundle must be a bounded local tar file");
  const bytes = await readFile(file);
  if (expected && `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== expected) throw new Error("Override bundle checksum mismatch");
  await extractBundleBytes(bytes, destination);
};

/** Validated archive bytes are extracted only after digest validation by the caller. */
export const extractBundleBytes = async (bytes: Buffer, destination: string): Promise<void> => {
  validateWorkspaceBundleTar(bytes);
  await mkdir(destination, { recursive: true });
  const text = (buffer: Buffer) => buffer.toString("utf8").replace(/\0.*$/su, "");
  for (let offset = 0; offset < bytes.length && !bytes.subarray(offset, offset + 512).every((byte) => byte === 0);) {
    const header = bytes.subarray(offset, offset + 512), prefix = text(header.subarray(345, 500)), name = text(header.subarray(0, 100));
    const target = path.join(destination, safeCommittedPath(`${prefix ? `${prefix}/` : ""}${name}`.replace(/\/$/u, "")));
    const size = Number.parseInt(text(header.subarray(124, 136)).trim(), 8);
    if (header[156] === 53) await mkdir(target, { recursive: true });
    else {
      await mkdir(path.dirname(target), { recursive: true });
      const executable = Number.parseInt(text(header.subarray(100, 108)).trim(), 8) & 0o111;
      await writeFile(target, bytes.subarray(offset + 512, offset + 512 + size), { flag: "wx", mode: executable ? 0o755 : 0o644 });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
};
