import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { trainingProject, writeTrainingFile, teamFiles, teamManifest, volume, example, network } from "../plan/fixtures.test-helper.js";
import { loadTrainingProject, resolveTrainingPlan } from "../plan/index.js";
import { rewindGitEnvironment } from "./gitProcess.js";
import { resolveFeedSource } from "../../../volume/feedSource.js";
import type { MomentRecord } from "./contract.js";
import type { MemoryLedgerEvent } from "./memorySchemas.js";

export const AT = "2026-10-09T08:20:31Z";
export const BEFORE = "2026-10-09T07:00:00Z";
export const FUTURE = "2026-10-09T08:20:31.001Z";
export const memoryEvent = (seq: number, createdAt = BEFORE): MemoryLedgerEvent => ({
  id: `event-${seq}`, seq, createdAt, type: "memory.observed", principal: { agentId: "a", scope: "global" },
  scope: "global", visibility: "global", source: "rewind-test", content: { kind: "text", text: `Fact ${seq}` },
  tags: [], entities: [], sensitivity: "normal", parentEventIds: [], checksum: `checksum-${seq}`
});
export const emptyRecord = (agent = "agent:a", at = AT): MomentRecord => ({
  version: "spawnfile.moment-record.v1", agent, wake: { at, surface: "moltnet", room: "assignment", from: "brass" },
  recordedAt: FUTURE, resources: [], feeds: [], memory: [], moltnet: [], volumes: []
});
export const jsonl = async (root: string, relative: string, values: unknown[]): Promise<void> => {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : ""));
};
export const testGit = (repo: string, args: string[], date = BEFORE): string => execFileSync("git", ["-C", repo, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...rewindGitEnvironment(), GIT_AUTHOR_NAME: "Rewind", GIT_AUTHOR_EMAIL: "rewind@example.invalid",
    GIT_COMMITTER_NAME: "Rewind", GIT_COMMITTER_EMAIL: "rewind@example.invalid", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
}).trim();

/** Real compiled team with all five storage paths, including a historical git feed. */
export const rewindFixture = async () => {
  const root = await trainingProject(teamFiles());
  const historyDir = path.join(root, "history"), gitRepo = path.join(historyDir, "git/team%3Apublication/code");
  await mkdir(gitRepo, { recursive: true });
  testGit(gitRepo, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(path.join(gitRepo, "news.txt"), "Before the wake\n");
  testGit(gitRepo, ["add", "."]); testGit(gitRepo, ["commit", "--quiet", "-m", "before"]);
  const commit = testGit(gitRepo, ["rev-parse", "HEAD"]);
  const feedRepo = path.join(historyDir, "feeds/team%3Apublication/news/repo");
  await mkdir(path.dirname(feedRepo), { recursive: true });
  testGit(root, ["clone", "--quiet", "--no-local", gitRepo, feedRepo]);
  const feedSource = resolveFeedSource({ kind: "git", repo: feedRepo, ref: commit, fetch: false });
  await jsonl(historyDir, "feeds/team%3Apublication/news/landings.jsonl", [{ revision: feedSource.revision,
    tree: feedSource.revision, commit, ref: "main", paths: null, landedAt: BEFORE }]);
  await writeFile(path.join(gitRepo, "future.txt"), "secret after wake\n");
  testGit(gitRepo, ["add", "."]); testGit(gitRepo, ["commit", "--quiet", "-m", "future"], "2026-10-10T00:00:00Z");
  const futureCommit = testGit(gitRepo, ["rev-parse", "HEAD"]);
  const resources = [volume, { id: "code", kind: "git", mount: "./code", mode: "readonly", url: gitRepo, branch: "main" },
    { id: "news", kind: "volume", name: "news", mount: "./news", mode: "mutable", feed: { git: { repo: feedRepo } } }];
  const manifest = teamManifest({ memory: [] });
  manifest.shared.workspace.resources = resources as typeof manifest.shared.workspace.resources;
  await writeTrainingFile(root, "Spawnfile", manifest);
  await writeTrainingFile(root, "training/train.yaml", { examples: [{ ...example, networks: [network] }] });
  await jsonl(historyDir, "memory/agent%3Aa/self/events.jsonl", [memoryEvent(1), memoryEvent(2, FUTURE)]);
  const data = Buffer.from("snapshot bytes\n"), digest = createHash("sha256").update(data).digest("hex");
  await jsonl(historyDir, "volumes/team%3Apublication/edition-state/snapshots.jsonl", [
    { snapshot: "snapshot-1", takenAt: BEFORE, parent: null, files: { "saved.txt": digest } }
  ]);
  const objectDir = path.join(historyDir, "volumes/team%3Apublication/edition-state/objects");
  await mkdir(objectDir, { recursive: true }); await writeFile(path.join(objectDir, digest), data);
  const project = await loadTrainingProject(root), plan = resolveTrainingPlan(project, "agent:a", "test");
  return { root, historyDir, project, plan, gitRepo, futureCommit, commit, feedRepo,
    options: { project, plan, example: example.id, historyDir, out: path.join(root, "out") } };
};
