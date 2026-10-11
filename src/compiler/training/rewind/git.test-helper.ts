import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MomentRecord } from "./contract.js";
import { rewindGitEnvironment } from "./gitProcess.js";

export const gitTestRoot = async (): Promise<string> => realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-rewind-git-")));
export const testGit = (repository: string, args: string[], at = "2026-10-09T08:00:00Z"): string => execFileSync("git", [
  "-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", "-C", repository, ...args
], { encoding: "utf8", env: { ...rewindGitEnvironment(), GIT_AUTHOR_NAME: "Rewind Test", GIT_AUTHOR_EMAIL: "rewind@example.invalid",
  GIT_COMMITTER_NAME: "Rewind Test", GIT_COMMITTER_EMAIL: "rewind@example.invalid", GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }, stdio: ["ignore", "pipe", "pipe"] }).trim();
export const initTestGit = async (repository: string): Promise<void> => {
  await mkdir(repository, { recursive: true });
  testGit(repository, ["init", "--quiet", "--initial-branch=main", "--template="]);
};
export const commitTestGit = async (repository: string, files: Record<string, string>, at: string): Promise<string> => {
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(repository, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
  testGit(repository, ["add", "--all"]);
  testGit(repository, ["commit", "--quiet", "--allow-empty", "-m", `at ${at}`], at);
  return testGit(repository, ["rev-parse", "HEAD"]);
};
export const testMomentRecord = (at = "2026-10-09T08:20:31Z"): MomentRecord => ({
  version: "spawnfile.moment-record.v1", agent: "agent:writer", wake: { at, startedAt: at, executionId: "execution-17",
    deliveries: [{ deliveryId: "delivery-17", kind: "message", occurredAt: at }], surface: "moltnet", room: "assignment", from: "brass" },
  recordedAt: at, exact: true, resources: [], feeds: [], memory: [], moltnet: [], volumes: []
});
