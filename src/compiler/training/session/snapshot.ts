import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, lstat, mkdir, realpath, chmod, readdir, readlink, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sealFile, within, type SealedFile } from "../preparation/files.js";

const excluded = new Set([".spawn", ".runtime", "node_modules", ".venv", "coverage", "__pycache__"]);
const protectedNames = new Set([".grok", ".codex", ".claude", ".ssh", "auth.json", ".env", ".aws"]);

const capture = async (source: string, signal?: AbortSignal) => {
  const files: SealedFile[] = [], links: { destination: string; value: string }[] = [];
  let total = 0;
  const walk = async (file: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (depth > 32 || files.length + links.length > 10_000) throw Error("Candidate source exceeds snapshot bounds");
    const name = path.basename(file);
    if (protectedNames.has(name)) throw Error("Candidate source contains a credential path");
    if (file !== source && (name === ".git" || excluded.has(name))) return;
    const stat = await lstat(file), destination = path.relative(source, file);
    if (stat.isSymbolicLink()) {
      const value = await readlink(file);
      const target = path.resolve(path.dirname(file), value);
      if (path.isAbsolute(value) || !within(source, target) || !within(source, await realpath(file)) ||
        path.relative(source, target).split(path.sep).some(part => protectedNames.has(part) || excluded.has(part) || part === ".git")) {
        throw Error("Candidate source symlink escapes its sealed input");
      }
      links.push({ destination, value });
    } else if (stat.isDirectory()) {
      for (const child of (await readdir(file)).sort()) await walk(path.join(file, child), depth + 1);
    } else {
      const sealed = await sealFile(file, destination);
      total += sealed.size;
      if (total > 1_073_741_824) throw Error("Candidate source exceeds snapshot byte bound");
      files.push(sealed);
    }
  };
  await walk(source, 0);
  return { files, links };
};

/** Copy only an explicit sealed input; never the caller's home or credential authority. */
export const snapshotTrainingSource = async (source: string, target: string, signal?: AbortSignal): Promise<void> => {
  if (await realpath(source) !== source || within(source, target) || within(target, source)) throw Error("Candidate source and scratch must be canonical and disjoint");
  signal?.throwIfAborted();
  const { files, links } = await capture(source, signal);
  const git = await lstat(path.join(source, ".git")).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (git) {
    // Retain one self-contained committed identity for declared bundle builds, without copying .git/config or refs.
    const execute = promisify(execFile);
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
    const command = async (cwd: string, args: string[]) => (await execute("git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", cwd, ...args], { signal, env, timeout: 30_000 })).stdout.trim();
    const revision = await command(source, ["rev-parse", "HEAD"]);
    if (!/^[a-f0-9]{40}$/u.test(revision)) throw Error("Candidate source has no committed Git identity");
    const common = await command(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    await mkdir(target, { mode: 0o700 });
    await command(target, ["init", "--quiet", "--template="]);
    await command(target, ["-c", "protocol.file.allow=always", "fetch", "--quiet", "--depth=1", pathToFileURL(common).href, revision]);
    await command(target, ["update-ref", "HEAD", revision]);
    await command(target, ["reset", "--mixed", "--quiet", revision]);
    await command(target, ["fsck", "--full", "--no-dangling"]);
  } else await mkdir(target, { mode: 0o700 });
  for (const file of files) {
    signal?.throwIfAborted();
    const destination = path.join(target, file.destination);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    // Git may have supplied an internal symlink here. Never follow it while installing current sealed bytes.
    const canonicalParent = await realpath(path.dirname(destination));
    if (!within(target, canonicalParent) || (await lstat(destination).catch(() => undefined))?.isSymbolicLink()) {
      throw Error("Candidate snapshot destination aliases another source");
    }
    await copyFile(file.source, destination);
    await chmod(destination, file.mode);
    if ((await sealFile(destination, file.destination)).sha256 !== file.sha256) throw Error("Candidate input changed during snapshot");
  }
  for (const link of links) {
    signal?.throwIfAborted();
    const destination = path.join(target, link.destination);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (!within(target, await realpath(path.dirname(destination)))) throw Error("Candidate link parent escapes scratch");
    await rm(destination, { force: true });
    await symlink(link.value, destination);
  }
  for (const link of links) if (!within(target, await realpath(path.join(target, link.destination)))) throw Error("Candidate link escapes scratch");
};
