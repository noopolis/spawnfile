import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, realpath, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SealMemo } from "./sealMemo.js";

export const within = (root: string, file: string): boolean => file === root || file.startsWith(root + path.sep);
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

export async function sealFile(source: string, destination: string, memo?: SealMemo): Promise<SealedFile> {
  await exactPath(source);
  const before = await lstat(source, { bigint: true });
  if (!before.isFile() || before.size > 536_870_912n) throw Error("Training source must be a regular file no larger than 512 MiB");
  const mode = Number(before.mode & 0o777n);
  const remembered = memo?.lookup(source, before);
  if (remembered !== undefined) return { source, destination, sha256: remembered, mode, size: Number(before.size) };
  const hashStartedNs = BigInt(Date.now() + 1) * 1_000_000n;
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  const digest = createHash("sha256"); let size = 0;
  let opened: BigIntStats, after: BigIntStats;
  try {
    opened = await handle.stat({ bigint: true });
    if (!sameFile(opened, before)) throw Error("Training source changed while hashing");
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
      size += chunk.length;
      if (size > 536_870_912) throw Error("Training source exceeded its size limit");
      digest.update(chunk);
    }
    after = await handle.stat({ bigint: true });
  } finally { await handle.close(); }
  const current = await lstat(source, { bigint: true });
  if (BigInt(size) !== before.size || !sameFile(after, before) || !sameFile(current, before)) throw Error("Training source changed while hashing");
  const sha256 = `sha256:${digest.digest("hex")}`;
  memo?.record(source, before, sha256, hashStartedNs);
  return { source, destination, sha256, mode, size };
}

const sameFile = (left: BigIntStats, right: BigIntStats): boolean => left.size === right.size && left.ino === right.ino &&
  left.dev === right.dev && left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs;

/** Only explicitly selected trees are traversed. Symlinks never enter Docker context. */
export async function sealTree(source: string, destination: string, options: { ignoreDevelopment?: boolean; ignoreGit?: boolean; internalSymlinks?: boolean; memo?: SealMemo } = {}): Promise<SealedFile[]> {
  await exactPath(source);
  const files: SealedFile[] = [];
  const walk = async (root: string, target: string, depth: number): Promise<void> => {
    if (depth > 32 || files.length > 10000) throw Error("Training source tree exceeds bounds");
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
    } else files.push(await sealFile(root, target, options.memo));
  };
  await walk(source, destination, 0);
  if (files.length > 10000 || files.reduce((sum, file) => sum + file.size, 0) > 1_073_741_824) throw Error("Training source tree exceeds bounds");
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
