import { execFile, execFileSync } from "node:child_process";
import { compareInstants } from "./instant.js";

const LIMIT = 268_435_456;

/** Do not inherit GIT_DIR, injected -c options, credentials or user/system configuration. */
export const rewindGitEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1",
  GIT_ATTR_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0"
});

const argumentsFor = (repo: string, args: readonly string[]): string[] => [
  "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false",
  "-c", "core.logAllRefUpdates=false", "-c", "core.attributesFile=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always",
  "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "safe.directory=*", "-C", repo, ...args
];

/** Bounded argv-only git invocation. Local transport is the only enabled protocol. */
export const rewindGit = (repo: string, args: readonly string[], input?: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = execFile("git", argumentsFor(repo, args), {
      encoding: "buffer", env: rewindGitEnvironment(), maxBuffer: LIMIT, timeout: 60_000
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Rewind git ${args[0]} failed: ${stderr.toString("utf8").trim() || error.message}`));
      else resolve(stdout);
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });

/** Adapter for the existing synchronous feed revision function; it never fetches. */
export const rewindGitSync = (repo: string, args: readonly string[]): Buffer =>
  execFileSync("git", argumentsFor(repo, args), {
    env: rewindGitEnvironment(), maxBuffer: LIMIT, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000
  });

export interface SelectedCommit { commit: string; instant: string }

export const commitInstant = async (repo: string, commit: string): Promise<string> => {
  const timestamp = Number((await rewindGit(repo, ["show", "-s", "--format=%ct", commit, "--"])).toString().trim());
  if (!Number.isSafeInteger(timestamp)) throw new Error(`Commit ${commit} has an invalid committer date`);
  return new Date(timestamp * 1000).toISOString();
};

/** Plain trees discard git metadata, so reject a future selected commit before that evidence disappears. */
export const assertCommitNotFuture = async (repo: string, commit: string, at: string): Promise<void> => {
  const dates = (await rewindGit(repo, ["show", "-s", "--format=%at %ct", commit, "--"])).toString().trim().split(" ");
  if (dates.length !== 2 || dates.some((value) => !Number.isSafeInteger(Number(value)) || compareInstants(new Date(Number(value) * 1000).toISOString(), at) > 0)) {
    throw new Error(`Selected commit ${commit} has an author or committer date after ${at}`);
  }
};

export const resolveRewindCommit = async (repo: string, selector: string): Promise<string> => {
  if (!selector || selector.startsWith("-") || /[\0\r\n]/u.test(selector)) throw new Error("Invalid git selector");
  const ref = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(selector) ? selector.toLowerCase() : selector;
  return (await rewindGit(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).toString().trim();
};

/** Dates approximate ref history; they cannot establish when a commit reached a moving ref. */
export const commitAt = async (repo: string, selector: string, at: string): Promise<SelectedCommit | null> => {
  let head: string;
  try { head = await resolveRewindCommit(repo, selector); } catch { return null; }
  const lines = (await rewindGit(repo, ["log", "--first-parent", "--format=%H %ct", head, "--"]))
    .toString().trim().split("\n").filter(Boolean);
  return selectCommitAt(lines.map((line) => {
    const [commit, seconds] = line.split(" ");
    return { commit: commit!, instant: new Date(Number(seconds) * 1000).toISOString() };
  }), at);
};

/** Stable ties preserve the first-parent order returned by git. */
export const selectCommitAt = (commits: readonly SelectedCommit[], at: string): SelectedCommit | null =>
  commits.filter((entry) => compareInstants(entry.instant, at) <= 0)
    .reduce<SelectedCommit | null>((latest, entry) => latest === null || compareInstants(entry.instant, latest.instant) > 0 ? entry : latest, null);
