import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FeedIdentity } from "../../../volume/feedRecord.js";
import type { LeakCheck, MaterializedInput } from "./contract.js";
import { assertLocalGitRepository } from "./gitHistory.js";
import { rewindGit } from "./gitProcess.js";
import { historyKey, openHistory } from "./history.js";
import { instantNanos } from "./instant.js";
import { diskPath } from "./leakFiles.js";
import { addInputFinding } from "./leakInputs.js";
import { verifyRecordedBundle } from "./recordedBundle.js";
import { digestDirectory } from "../../../volume/index.js";
import { exportGitTree } from "./gitTree.js";

const inspectBundleTree = async (repository: string, commit: string, directory: string, input: MaterializedInput): Promise<void> => {
  if (!input.source.trees?.length) throw new Error("Missing bundle source tree selection");
  const scratch = await mkdtemp(path.join(os.tmpdir(), "spawnfile-bundle-check-"));
  try {
    for (const tree of input.source.trees) await exportGitTree(repository, commit, scratch, { ...tree, mergeIdentical: true });
    if (digestDirectory(directory) !== digestDirectory(scratch)) throw new Error("Bundle bytes disagree with selected commit, roots and exclusions");
  } finally { await rm(scratch, { recursive: true, force: true }); }
};

/** Read receipts and source objects afresh; never trust the producer's date guard or stamped files. */
export const inspectInputProvenance = async (
  root: string, input: MaterializedInput, report: LeakCheck, historyDir?: string
): Promise<void> => {
  const add = (detail: string) => addInputFinding(report, input, "git-object", detail);
  try {
    if (input.kind === "bundle" && (input.basis === "record" || input.basis === "deploy-log") && input.source.sha256) {
      await verifyRecordedBundle(await openHistory(historyDir), input.source.sha256, await diskPath(root, input.path!));
      return;
    }
    const commit = input.source.commit;
    if (input.kind === "feed") {
      if (input.fidelity === "overridden") return;
      const identity: FeedIdentity = JSON.parse(await readFile(await diskPath(root, `${input.path}/.spawnfile-feed.json`), "utf8"));
      if (identity.source?.kind === "git") {
        if (!commit || identity.source.commit !== commit) add("Feed source commit disagrees with moment provenance");
      } else if (!commit) return; // Directory feeds have no git provenance.
    } else if (input.kind === "bundle" && input.fidelity === "overridden" && !commit && !input.source.repository) {
      return; // Explicit prebuilt tar overrides have no source commit.
    }
    if (!commit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) throw new Error("Missing or invalid source commit provenance");
    let repository: string;
    if (input.source.repository) {
      // Only locally resolved pins/overrides may lack an entry in the history layout.
      if (input.kind === "feed" || input.basis !== "pinned" && input.fidelity !== "overridden"
        || !path.isAbsolute(input.source.repository)) throw new Error("Invalid local provenance repository");
      repository = input.source.repository;
      await assertLocalGitRepository(repository);
    } else {
      const history = await openHistory(historyDir);
      const key = input.kind === "feed" ? `feeds/${historyKey(input)}/repo` : `git/${historyKey(input)}`;
      const retained = await history?.repository(key);
      if (!retained) throw new Error(`Missing source history repository for provenance: ${key}`);
      repository = retained;
      await assertLocalGitRepository(repository, history);
    }
    const type = (await rewindGit(repository, ["cat-file", "-t", commit])).toString().trim();
    if (type !== "commit") throw new Error(`Provenance object ${commit} must be a commit object; found ${type}`);
    const headers = (await rewindGit(repository, ["cat-file", "commit", commit])).toString().split("\n\n", 1)[0]!;
    report.checked.gitObjects++;
    for (const role of ["author", "committer"]) {
      const match = new RegExp(`^${role} .* (-?\\d+) [+-]\\d{4}$`, "mu").exec(headers);
      if (!match) add(`Provenance commit ${commit} has no valid ${role} date`);
      else if (BigInt(match[1]!) * 1_000_000_000n > instantNanos(report.at)) add(`Provenance commit ${commit} has a future ${role} date`);
    }
    if (input.kind === "bundle") await inspectBundleTree(repository, commit, await diskPath(root, input.path!), input);
  } catch (error) { add(error instanceof Error ? error.message : String(error)); }
};
