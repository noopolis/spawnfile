import { lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { rewindGit } from "./gitProcess.js";
import { safeCommittedPath } from "./gitTree.js";

const BLOCK = 512;
const field = (bytes: Buffer): string => bytes.toString("utf8").replace(/\0.*$/su, "");
const octal = (bytes: Buffer): number => {
  const value = field(bytes).trim();
  if (!/^[0-7]+$/u.test(value)) throw new Error("Invalid git archive numeric field");
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Invalid git archive size");
  return number;
};

const pax = (bytes: Buffer): Record<string, string> => {
  const result: Record<string, string> = {};
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset), length = Number(bytes.subarray(offset, space).toString("ascii"));
    if (space < offset || !Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) {
      throw new Error("Invalid git archive PAX field");
    }
    const value = bytes.subarray(space + 1, offset + length - 1).toString("utf8"), equal = value.indexOf("=");
    if (equal <= 0) throw new Error("Invalid git archive PAX value");
    result[value.slice(0, equal)] = value.slice(equal + 1);
    offset += length;
  }
  return result;
};

/** Never follow an archive symlink while creating a later entry beneath it. */
const parentDirectory = async (root: string, relative: string): Promise<void> => {
  let directory = root;
  for (const segment of relative.split("/").slice(0, -1)) {
    directory = path.join(directory, segment);
    const existing = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (existing && !existing.isDirectory()) throw new Error(`Git archive entry traverses a non-directory: ${relative}`);
    if (!existing) await mkdir(directory);
  }
};

/** Git feeds use git archive, including committed export-ignore/export-subst attributes. */
export const exportFeedGitTree = async (repository: string, commit: string, destination: string, paths?: string[]): Promise<void> => {
  for (const selected of paths ?? []) safeCommittedPath(selected);
  const archive = await rewindGit(repository, ["archive", "--format=tar", commit, ...(paths ? ["--", ...paths] : [])]);
  await mkdir(destination, { recursive: true });
  let extended: Record<string, string> = {}, entries = 0, terminated = false;
  for (let offset = 0; offset + BLOCK <= archive.length;) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      if (offset + 2 * BLOCK > archive.length || !archive.subarray(offset).every((byte) => byte === 0)) throw new Error("Invalid git archive termination");
      terminated = true;
      break;
    }
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (field(header.subarray(257, 263)) !== "ustar" || checksum !== octal(header.subarray(148, 156))) throw new Error("Invalid git archive header");
    const size = octal(header.subarray(124, 136)), mode = octal(header.subarray(100, 108)), type = String.fromCharCode(header[156] || 48);
    const data = archive.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (data.length !== size || offset > archive.length) throw new Error("Truncated git archive");
    if (type === "g" || type === "x") {
      const values = pax(data);
      if (type === "x") extended = values;
      else if (values.path || values.linkpath || values.size) throw new Error("Unsupported global git archive path override");
      continue;
    }
    const prefix = field(header.subarray(345, 500));
    const name = safeCommittedPath((extended.path ?? `${prefix ? `${prefix}/` : ""}${field(header.subarray(0, 100))}`).replace(/\/$/u, ""));
    const link = extended.linkpath ?? field(header.subarray(157, 257));
    if (extended.size && Number(extended.size) !== size) throw new Error("Unsupported git archive size override");
    extended = {};
    if (!["0", "2", "5"].includes(type) || (type !== "0" && size)) throw new Error(`Unsupported git archive entry ${name}`);
    await parentDirectory(destination, name);
    const target = path.join(destination, name);
    if (type === "5") await mkdir(target);
    else if (type === "2") await symlink(link, target);
    else await writeFile(target, data, { flag: "wx", mode: mode & 0o111 ? 0o755 : 0o644 });
    entries += 1;
  }
  if (!terminated || !entries) throw new Error("Git feed archive is empty or lacks valid termination");
};
