import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { materializedMomentSchema, leakCheckSchema, type LeakCheck, type LeakFinding } from "./contract.js";
import { openHistory } from "./history.js";
import { diskPath, inspectBundleFiles } from "./leakFiles.js";
import { inspectGitBundle } from "./leakGit.js";
import { addInputFinding, inspectFeedBundle, inspectMemoryBundle, inspectMoltnetBundle, inspectVolumeBundle } from "./leakInputs.js";

export interface LeakCheckOptions { historyDir?: string }

/** Independent acceptance boundary: only disk reports, disk payloads and disk history are trusted. */
export const leakCheckTrainingMoment = async (bundle: string, options: LeakCheckOptions = {}): Promise<LeakCheck> => {
  const root = await realpath(path.resolve(bundle));
  const moment = materializedMomentSchema.parse(JSON.parse(await readFile(await diskPath(root, "moment.json"), "utf8")));
  const report: LeakCheck = { version: "spawnfile.leak-check.v1", at: moment.at, ok: false,
    checked: { files: 0, gitObjects: 0, memoryEvents: 0, moltnetMessages: 0, moltnetEvents: 0, snapshots: 0 }, findings: [] };
  await inspectBundleFiles(root, moment.inputs, report);
  for (const input of moment.inputs) {
    const kind: LeakFinding["class"] = input.kind === "memory" ? "memory-event"
      : input.kind === "moltnet" ? "moltnet-message" : input.kind === "feed" ? "feed-identity"
        : input.kind === "volume" ? "snapshot" : "git-object";
    try {
      if (!input.path || input.refusal || !input.fidelity) throw new Error("Input is not materialized");
      const directory = await diskPath(root, input.path);
      // Do not hand git/SQLite a payload with escaping paths, even for a failed check.
      if (report.findings.some((finding) => finding.class === "symlink-escape"
        && (finding.path === input.path || finding.path.startsWith(`${input.path}/`)))) continue;
      if (input.kind === "git") await inspectGitBundle(directory, input, report);
      if (input.kind === "memory") await inspectMemoryBundle(root, input, report);
      if (input.kind === "feed") await inspectFeedBundle(root, input, report);
      if (input.kind === "moltnet") await inspectMoltnetBundle(root, input, report);
      if (input.kind === "volume") await inspectVolumeBundle(root, input, report, await openHistory(options.historyDir));
    } catch (error) {
      addInputFinding(report, input, kind, error instanceof Error ? error.message : String(error), input.path ?? ".");
    }
  }
  report.ok = report.findings.length === 0;
  return leakCheckSchema.parse(report);
};
