import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { SpawnfileError } from "../shared/index.js";

const run = promisify(execFile);
const COMMIT = /^[a-f0-9]{40}$/u;

/** Which remote ref a `fetch: build` git resource follows. `none` follows the remote's default branch. */
export interface GitPinSelector {
  kind: "branch" | "none" | "ref" | "tag";
  value: string;
}

/** Host-side SSH credential. Exactly one source; neither is ever written into the compile output. */
export interface GitPinAuth {
  sshKey?: string;
  sshKeyEnv?: string;
}

export interface GitPinFetch {
  /** Bare cache repository the commit's objects now live in. */
  repository: string;
  commit: string;
}

const fail = (message: string): never => {
  throw new SpawnfileError("validation_error", message);
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

/** The remote ref to fetch, and the commit it must equal when the selector already names one. */
export const gitPinRefspec = (selector: GitPinSelector): { expected?: string; source: string } => {
  if (selector.kind === "branch") return { source: `refs/heads/${selector.value}` };
  if (selector.kind === "tag") return { source: `refs/tags/${selector.value}` };
  if (selector.kind === "ref") return COMMIT.test(selector.value) ? { expected: selector.value, source: selector.value } : { source: selector.value };
  return { source: "HEAD" };
};

/**
 * Runs `use` with the git environment for one fetch. A key held in an env var
 * is copied to a private 0600 file in a fresh temporary directory that is
 * removed afterwards; the key only ever reaches git through `GIT_SSH_COMMAND`.
 */
export const withGitPinEnvironment = async <T>(
  auth: GitPinAuth | undefined,
  use: (env: NodeJS.ProcessEnv) => Promise<T>,
  environment: NodeJS.ProcessEnv = process.env
): Promise<T> => {
  // Never prompt, never honour replacement refs: an object id must name its own bytes.
  const base: NodeJS.ProcessEnv = { ...environment, GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" };
  if (auth === undefined) return use(base);
  let temporary: string | undefined;
  try {
    let keyPath: string;
    if (auth.sshKeyEnv !== undefined) {
      const material = environment[auth.sshKeyEnv];
      if (!material?.trim()) fail(`git resource auth env ${auth.sshKeyEnv} is not set`);
      temporary = await mkdtemp(path.join(os.tmpdir(), "spawnfile-git-key-"));
      keyPath = path.join(temporary, "key");
      await writeFile(keyPath, material!.endsWith("\n") ? material! : `${material!}\n`, { mode: 0o600 });
    } else {
      keyPath = auth.sshKey!;
      const info = await stat(keyPath).catch(() => undefined);
      if (!info?.isFile()) fail(`git resource ssh_key is not a readable file: ${keyPath}`);
    }
    const ssh = `ssh -i ${shellQuote(keyPath)} -o IdentitiesOnly=yes -o BatchMode=yes`;
    return await use({ ...base, GIT_SSH_COMMAND: ssh });
  } finally {
    if (temporary !== undefined) await rm(temporary, { force: true, recursive: true });
  }
};

const git = async (repository: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> => {
  const { stdout } = await run("git", ["-C", repository, ...args], { encoding: "utf8", env, maxBuffer: 16_777_216 });
  return stdout.trim();
};

/** One bare object cache per remote URL. Auto-gc is off: a concurrent compile may still be reading a commit. */
export const ensureGitPinRepository = async (cacheDirectory: string, url: string): Promise<string> => {
  const repository = path.join(cacheDirectory, `${createHash("sha256").update(url).digest("hex")}.git`);
  if (!(await stat(path.join(repository, "HEAD")).catch(() => undefined))) {
    await mkdir(cacheDirectory, { mode: 0o700, recursive: true });
    await run("git", ["init", "--bare", "-q", repository]);
    await run("git", ["-C", repository, "config", "gc.auto", "0"]);
  }
  return repository;
};

const hasCommit = (repository: string, commit: string, env: NodeJS.ProcessEnv): Promise<boolean> =>
  git(repository, ["cat-file", "-e", `${commit}^{commit}`], env).then(() => true, () => false);

/**
 * Resolves `selector` on `url` to one commit and fetches its objects into the
 * cache, shallowly. A full commit id already in the cache is not fetched
 * again, so a recorded pin rebuilds offline. Any failure to resolve refuses
 * the compile: a pinned resource never falls back to stale or empty content.
 */
export const fetchGitPin = async (
  cacheDirectory: string,
  url: string,
  selector: GitPinSelector,
  env: NodeJS.ProcessEnv
): Promise<GitPinFetch> => {
  const repository = await ensureGitPinRepository(cacheDirectory, url);
  const { expected, source } = gitPinRefspec(selector);
  if (expected !== undefined && await hasCommit(repository, expected, env)) return { commit: expected, repository };
  // A per-process ref: concurrent compiles sharing the cache never read each other's result.
  const local = `refs/spawnfile/pins/${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await git(repository, ["fetch", "--quiet", "--no-tags", "--depth=1", "--", url, `+${source}:${local}`], env);
    const commit = await git(repository, ["rev-parse", "--verify", `${local}^{commit}`], env);
    if (!COMMIT.test(commit)) fail(`git resource ${url} ${selector.kind} ${selector.value} did not resolve to a commit`);
    if (expected !== undefined && commit !== expected) fail(`git resource ${url} ref ${expected} resolved to ${commit}`);
    return { commit, repository };
  } catch (error) {
    if (error instanceof SpawnfileError) throw error;
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim().split("\n").filter(Boolean).pop();
    const what = selector.kind === "none" ? "default branch" : `${selector.kind} ${selector.value}`;
    return fail(`git resource ${url} ${what} could not be resolved to a commit${stderr ? `: ${stderr}` : ""}`);
  } finally {
    await git(repository, ["update-ref", "-d", local], env).catch(() => undefined);
  }
};
