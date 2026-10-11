import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { feedIdentityFindings, type FeedIdentity } from "../../../volume/feedRecord.js";
import type { LeakCheck, LeakFinding, MaterializedInput } from "./contract.js";
import { historyKey, inside, type History } from "./history.js";
import { compareInstants } from "./instant.js";
import { diskPath } from "./leakFiles.js";
import { parseMemoryLedger } from "./memory.js";
import { inspectMoltnetJson } from "./moltnetJson.js";
import { inspectMoltnetSqlite } from "./moltnetSqlite.js";
import { replayVolumeSnapshot, volumeSnapshotSchema } from "./volumes.js";

export const addInputFinding = (report: LeakCheck, input: MaterializedInput, kind: LeakFinding["class"], detail: string, file = input.path!): void => {
  report.findings.push({ input: { section: input.section, id: input.id, declaredBy: input.declaredBy }, class: kind, path: file, detail });
};

export const inspectMemoryBundle = async (root: string, input: MaterializedInput, report: LeakCheck): Promise<void> => {
  const home = await diskPath(root, input.path!);
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (/^(?:index\.sqlite(?:$|[-.])|causal|authority-receipts)/u.test(entry.name)) {
        addInputFinding(report, input, "memory-event", `Derived or audit memory state ${entry.name} is forbidden`);
      }
      if (entry.isDirectory()) await visit(path.join(directory, entry.name));
    }
  };
  await visit(home);
  const ledger = parseMemoryLedger(await readFile(await diskPath(root, `${input.path}/memory/events.jsonl`), "utf8"));
  report.checked.memoryEvents += ledger.events.length;
  let native = false;
  for (const [index, event] of ledger.events.entries()) {
    if (event.seq === undefined ? native : event.seq !== index + 1) {
      addInputFinding(report, input, "memory-event", `Noncontiguous memory sequence at line ${index + 1}`);
    }
    native ||= event.seq !== undefined;
    if (compareInstants(event.createdAt, report.at) > 0) addInputFinding(report, input, "memory-event", `Future memory event at line ${index + 1}`);
    if (index > 0 && compareInstants(event.createdAt, ledger.events[index - 1]!.createdAt) < 0) {
      addInputFinding(report, input, "memory-event", `Memory clock regression at line ${index + 1}`);
    }
  }
  if (input.source.seq !== ledger.events.length) addInputFinding(report, input, "memory-event", "Ledger length disagrees with the materialized sequence");
};

export const inspectFeedBundle = async (root: string, input: MaterializedInput, report: LeakCheck): Promise<void> => {
  const directory = await diskPath(root, input.path!);
  if (input.fidelity === "overridden") {
    if ((await readdir(directory)).length) addInputFinding(report, input, "feed-identity", "Overridden feed volume must be empty");
    return;
  }
  const identity: FeedIdentity = JSON.parse(await readFile(await diskPath(root, `${input.path}/.spawnfile-feed.json`), "utf8"));
  for (const issue of feedIdentityFindings(identity)) addInputFinding(report, input, "feed-identity", issue);
  if (compareInstants(identity.landed_at, report.at) > 0) addInputFinding(report, input, "feed-identity", "Feed landed_at is later than the moment");
  if (identity.resource !== input.id || identity.revision !== input.source.revision) {
    addInputFinding(report, input, "feed-identity", "Feed identity disagrees with the moment input");
  }
  const current = path.join(directory, "current");
  if (!(await lstat(current)).isSymbolicLink()) throw new Error("Feed current must be a relative symlink");
  const link = await readlink(current);
  if (link !== identity.tree || !/^trees\/[a-f0-9]{64}(?:\.[1-9][0-9]*)?$/u.test(link)
    || !inside(path.join(directory, "trees"), await realpath(current))) {
    addInputFinding(report, input, "feed-identity", "Feed current does not point to its tree inside the volume");
  } else if (!(await lstat(await realpath(current))).isDirectory()) addInputFinding(report, input, "feed-identity", "Feed tree must be a directory");
};

export const inspectMoltnetBundle = async (root: string, input: MaterializedInput, report: LeakCheck): Promise<void> => {
  const directory = await diskPath(root, input.path!);
  const stores = (await readdir(directory)).filter((name) => name === "state.json" || name === "moltnet.sqlite");
  if (stores.length !== 1) throw new Error("Expected exactly one Moltnet store");
  const store = await diskPath(root, `${input.path}/${stores[0]}`);
  const result = stores[0] === "state.json" ? await inspectMoltnetJson(store, report.at) : await inspectMoltnetSqlite(store, report.at);
  report.checked.moltnetMessages += result.messages;
  report.checked.moltnetEvents += result.events;
  for (const finding of result.findings) addInputFinding(report, input, finding.class, finding.detail, path.relative(root, finding.path));
};

export const inspectVolumeBundle = async (root: string, input: MaterializedInput, report: LeakCheck, history?: History): Promise<void> => {
  let expected: Record<string, string> = {};
  if (input.fidelity !== "overridden") {
    if (!history || !input.source.snapshot) throw new Error("Snapshot verification requires its history and selected snapshot");
    const snapshots = await history.jsonl(`volumes/${historyKey(input)}/snapshots.jsonl`, volumeSnapshotSchema);
    if (!snapshots) throw new Error("Snapshot history is missing");
    const replay = replayVolumeSnapshot(snapshots, input.source.snapshot);
    if (compareInstants(replay.takenAt, report.at) > 0) throw new Error("Selected snapshot is later than the moment");
    expected = replay.files;
    report.checked.snapshots += replay.chain.length;
  }
  const found = new Set<string>();
  const directories = new Set<string>();
  for (const name of Object.keys(expected)) {
    for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) directories.add(parent);
  }
  const visit = async (relative: string): Promise<void> => {
    const folder = await diskPath(root, `${input.path}${relative ? `/${relative}` : ""}`);
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!directories.has(name)) addInputFinding(report, input, "snapshot", `Unexpected snapshot directory ${name}`);
        await visit(name);
      } else {
        found.add(name);
        if (!entry.isFile() || !Object.hasOwn(expected, name)) addInputFinding(report, input, "snapshot", `Unexpected snapshot entry ${name}`);
        else {
          const digest = createHash("sha256").update(await readFile(await diskPath(root, `${input.path}/${name}`))).digest("hex");
          if (digest !== expected[name]) addInputFinding(report, input, "snapshot", `Snapshot digest mismatch for ${name}`);
        }
      }
    }
  };
  await visit("");
  for (const name of Object.keys(expected)) if (!found.has(name)) addInputFinding(report, input, "snapshot", `Missing snapshot file ${name}`);
};
