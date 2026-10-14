import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readdir, realpath, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const within = (root: string, file: string): boolean => file === root || file.startsWith(root + path.sep);
/** Training outputs, preparations and launch receipts reserve evaluator storage across runs. */
export function assertNotEvaluatorStorage(source: string): void {
  const parts = path.resolve(source).split(path.sep);
  const retainedOutput = parts.some((part, index) => part === ".spawn" && parts[index + 1] === "training");
  if (retainedOutput || parts.some(part => /^\.spawnfile-training-(?:preparation-[a-f0-9]{16}$|container-)/u.test(part))) {
    throw Error("Private training assets in retained evaluator storage must not enter image inputs or public inputs");
  }
}
export const hashJson = (value: unknown): string => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
export interface SealedFile { source: string; destination: string; sha256: string; mode: number; size: number }
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

/** Only explicitly selected trees are traversed. Symlinks never enter Docker context. */
export async function trainingTreeFiles(source: string, destination: string, options: { ignoreDevelopment?: boolean; ignoreGit?: boolean; internalSymlinks?: boolean; rejectEvaluatorStorage?: boolean } = {}): Promise<{ source: string; destination: string }[]> {
  await exactPath(source);
  const files: { source: string; destination: string }[] = [];
  const walk = async (root: string, target: string, depth: number): Promise<void> => {
    if (depth > 32 || files.length > 10000) throw Error("Training source tree exceeds bounds");
    if (options.rejectEvaluatorStorage) assertNotEvaluatorStorage(root);
    let stat = await lstat(root);
    if (stat.isSymbolicLink()) {
      const actual = await realpath(root);
      if (!options.internalSymlinks || !within(source, actual)) throw Error("Training source trees must not contain escaping symlinks");
      root = actual; stat = await lstat(root);
    }
    if (stat.isDirectory()) {
      for (const entry of (await readdir(root)).sort()) {
        if (options.ignoreGit && entry === ".git") continue;
        if (options.ignoreDevelopment && (ignored.has(entry) || /(?:\.test\.[cm]?[jt]s|_test\.py|\.pyc)$/u.test(entry))) continue;
        await walk(path.join(root, entry), path.posix.join(target, entry), depth + 1);
      }
    } else files.push({ source: root, destination: target });
  };
  await walk(source, destination, 0);
  if (files.length > 10000) throw Error("Training source tree exceeds bounds");
  return files;
}

export async function sealTree(source: string, destination: string, options: Parameters<typeof trainingTreeFiles>[2] = {}): Promise<SealedFile[]> {
  const files: SealedFile[] = [];
  for (const file of await trainingTreeFiles(source, destination, options)) files.push(await sealFile(file.source, file.destination));
  if (files.reduce((sum, file) => sum + file.size, 0) > 1_073_741_824) throw Error("Training source tree exceeds bounds");
  return files;
}

export async function copySealed(files: readonly SealedFile[], root: string): Promise<void> {
  for (const file of files) {
    const target = path.resolve(root, file.destination);
    if (!within(root, target) || target === root) throw Error("Training destination escapes owned staging");
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(file.source, target, 1);
    await chmod(target, file.mode);
    const copied = await sealFile(target, file.destination);
    if (copied.sha256 !== file.sha256 || copied.size !== file.size) throw Error("Training source changed during staging");
  }
}

export const fileIdentity = (files: readonly SealedFile[]) => files.map(({ destination, sha256, mode, size }) => ({ destination, sha256, mode, size }));
