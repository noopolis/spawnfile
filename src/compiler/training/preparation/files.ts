import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readlink, realpath, chmod, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const within = (root: string, file: string): boolean => file === root || file.startsWith(root + path.sep);
export const hashJson = (value: unknown): string => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
export interface SealedFile { source: string; destination: string; sha256: string; mode: number; size: number; target?: string; directory?: true }
const ignored = new Set(["node_modules", ".venv", ".git", "__pycache__", "coverage", "coverage.json", ".coverage", ".pytest_cache", ".runtime", "AGENTS.md", "CLAUDE.md"]);

export function assertInputRoot(source: string, auth: readonly string[]): void {
  const home = os.homedir();
  if (["/", "/etc", "/var", "/run", "/tmp", "/opt", "/usr", "/Users", "/home", home].includes(source) ||
    [".codex", ".claude", ".grok", ".ssh", ".config"].some(name => within(path.join(home, name), source)) ||
    auth.some(leaf => within(source, leaf) || within(leaf, source))) throw Error("Training input exposes a protected host root or auth leaf");
}

export async function exactPath(source: string): Promise<string> {
  const absolute = path.resolve(source);
  if (await realpath(absolute) !== absolute || (await lstat(absolute)).isSymbolicLink()) throw Error("Training source must be canonical, without symlink aliases");
  return absolute;
}

export async function sealFile(source: string, destination: string): Promise<SealedFile> {
  await exactPath(source);
  const before = await lstat(source, { bigint: true });
  if (!before.isFile() || before.size > 536_870_912n) throw Error("Training source must be a regular file no larger than 512 MiB");
  const digest = createHash("sha256"); let size = 0;
  for await (const chunk of createReadStream(source)) {
    size += chunk.length;
    if (size > 536_870_912) throw Error("Training source exceeded its size limit");
    digest.update(chunk);
  }
  const after = await lstat(source, { bigint: true });
  if (BigInt(size) !== before.size || after.size !== before.size || after.ino !== before.ino || after.ctimeNs !== before.ctimeNs || after.dev !== before.dev) throw Error("Training source changed while hashing");
  return { source, destination, sha256: `sha256:${digest.digest("hex")}`, mode: Number(before.mode & 0o777n), size };
}

function assertLink(root: string, file: string, target: string): void {
  // Absolute host paths cannot reproduce a confined link in a relocated snapshot.
  if (!target || path.isAbsolute(target) || !within(root, path.resolve(path.dirname(file), target))) {
    throw Error("Training source trees must not contain escaping symlinks");
  }
}

async function sealLink(source: string, destination: string): Promise<SealedFile> {
  const before = await lstat(source, { bigint: true }), target = await readlink(source);
  const after = await lstat(source, { bigint: true });
  if (!before.isSymbolicLink() || !after.isSymbolicLink() || after.ino !== before.ino ||
    after.ctimeNs !== before.ctimeNs || after.dev !== before.dev) throw Error("Training source changed while hashing");
  return { source, destination, target, sha256: hashJson({ type: "symlink", target }), mode: 0o777, size: Buffer.byteLength(target) };
}

/** Only physical entries are walked; confined input links retain their own identity. */
export async function sealTree(source: string, destination: string, options: { ignoreDevelopment?: boolean; ignoreGit?: boolean; internalSymlinks?: boolean } = {}): Promise<SealedFile[]> {
  await exactPath(source);
  const files: SealedFile[] = [];
  let entries = 0;
  const walk = async (root: string, target: string, depth: number): Promise<void> => {
    if (depth > 32) throw Error("Training source tree exceeds bounds");
    const stat = await lstat(root);
    if ((depth > 0 || !stat.isDirectory()) && ++entries > 10000) throw Error("Training source tree exceeds bounds");
    if (stat.isSymbolicLink()) {
      if (!options.internalSymlinks) throw Error("Training source trees must not contain escaping symlinks");
      const link = await sealLink(root, target);
      assertLink(source, root, link.target!);
      // Resolve only for containment validation, never to enumerate or copy the target.
      if (!within(source, await realpath(root))) throw Error("Training source trees must not contain escaping symlinks");
      files.push(link);
      return;
    }
    if (stat.isDirectory()) {
      const children = (await readdir(root)).sort().filter(entry => !(options.ignoreGit && entry === ".git") &&
        !(options.ignoreDevelopment && (ignored.has(entry) || /(?:\.test\.[cm]?[jt]s|_test\.py|\.pyc)$/u.test(entry))));
      // Retain empty input directories so their preserved links still resolve after relocation.
      if (options.internalSymlinks && !children.length && target) files.push({ source: root, destination: target,
        directory: true, sha256: hashJson({ type: "directory" }), mode: stat.mode & 0o777, size: 0 });
      for (const entry of children) {
        await walk(path.join(root, entry), path.posix.join(target, entry), depth + 1);
      }
    } else files.push(await sealFile(root, target));
  };
  await walk(source, destination, 0);
  if (files.length > 10000 || files.reduce((sum, file) => sum + file.size, 0) > 1_073_741_824) throw Error("Training source tree exceeds bounds");
  return files;
}

export async function copySealed(files: readonly SealedFile[], root: string): Promise<void> {
  const directories = new Set<string>();
  const ensureDirectory = async (directory: string): Promise<void> => {
    if (directories.has(directory)) return;
    const parent = path.dirname(directory);
    if (parent !== directory) {
      await ensureDirectory(parent);
      await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    }
    await exactPath(directory);
    if (!(await lstat(directory)).isDirectory()) throw Error("Training staging parent must be a directory");
    directories.add(directory);
  };
  await ensureDirectory(root);
  for (const file of files) {
    const target = path.resolve(root, file.destination);
    if (!within(root, target) || target === root) throw Error("Training destination escapes owned staging");
    await ensureDirectory(path.dirname(target));
    if (file.directory) { await ensureDirectory(target); await chmod(target, file.mode); continue; }
    if (file.target !== undefined) {
      assertLink(root, target, file.target);
      const current = await sealLink(file.source, file.destination);
      if (hashJson(fileIdentity([current])) !== hashJson(fileIdentity([file]))) throw Error("Training source changed during staging");
      await symlink(file.target, target);
      if (await readlink(target) !== file.target) throw Error("Training source changed during staging");
      continue;
    }
    await exactPath(file.source);
    await copyFile(file.source, target, 1);
    await chmod(target, file.mode);
    const copied = await sealFile(target, file.destination);
    if (copied.sha256 !== file.sha256 || copied.size !== file.size) throw Error("Training source changed during staging");
  }
  // Validate chains after every target has been staged, including links ordered before files.
  for (const file of files.filter(file => file.target !== undefined)) {
    if (!within(root, await realpath(path.join(root, file.destination)))) throw Error("Training staged symlink escapes owned staging");
  }
}

export const fileIdentity = (files: readonly SealedFile[]) => files.map(({ destination, sha256, mode, size, target, directory }) =>
  ({ destination, sha256, mode, size, ...(target !== undefined ? { type: "symlink" as const, target } : {}),
    ...(directory ? { type: "directory" as const } : {}) }));
