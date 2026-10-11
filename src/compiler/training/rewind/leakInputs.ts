import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { feedIdentityFindings, type FeedIdentity } from "../../../volume/feedRecord.js";
import type { LeakCheck, LeakFinding, MaterializedInput, MaterializedMoment } from "./contract.js";
import { digestDirectory } from "../../../volume/index.js";
import { permitsFeedPublicationTime } from "./leakFeed.js";
import { inside, safeSegment, type History } from "./history.js";
import { compareInstants } from "./instant.js";
import { diskPath } from "./leakFiles.js";
import { parseMemoryLedger } from "./memory.js";
import { inspectMoltnetJson } from "./moltnetJson.js";
import { inspectMoltnetSqlite } from "./moltnetSqlite.js";
import { readSnapshotManifest, snapshotBytes, snapshotHistoryPath, snapshotTreeFindings } from "./snapshotManifest.js";
import { wakeSnapshotRowSchema } from "./volumes.js";

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

export const inspectFeedBundle = async (root: string, input: MaterializedInput, report: LeakCheck, moment?: MaterializedMoment, history?: History): Promise<void> => {
  const directory = await diskPath(root, input.path!);
  if (input.fidelity === "overridden") {
    if ((await readdir(directory)).length) addInputFinding(report, input, "feed-identity", "Overridden feed volume must be empty");
    return;
  }
  const identity: FeedIdentity = JSON.parse(await readFile(await diskPath(root, `${input.path}/.spawnfile-feed.json`), "utf8"));
  for (const issue of feedIdentityFindings(identity)) addInputFinding(report, input, "feed-identity", issue);
  if (compareInstants(identity.landed_at, report.at) > 0 && !(moment && await permitsFeedPublicationTime(identity, input, moment, history))) {
    addInputFinding(report, input, "feed-identity", "Feed landed_at is later than the moment");
  }
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
  else if (identity.source.kind === "directory" && digestDirectory(await realpath(current)) !== identity.revision) {
    addInputFinding(report, input, "feed-identity", "Directory feed revision disagrees with retained bytes");
  }
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
  const directory = await diskPath(root, input.path!);
  if (input.fidelity === "overridden") {
    for (const name of await readdir(directory)) addInputFinding(report, input, "snapshot", `Unexpected snapshot entry ${name}`);
    return;
  }
  if (!history || !input.source.snapshot || !input.source.agentSlug) throw new Error("Snapshot verification requires its history, agent slug and selected snapshot");
  if (input.source.snapshot.endsWith(".partial")) throw new Error("Selected snapshot is partial");
  const relative = snapshotHistoryPath(input.source.agentSlug, input.id, input.source.snapshot);
  const manifest = await readSnapshotManifest(history, relative, input.id, input.source.snapshot);
  const retained = await history.path(relative);
  if (!manifest || !retained) throw new Error("Snapshot tree or manifest is missing");
  if (compareInstants(manifest.started_at, report.at) > 0) throw new Error("Selected snapshot is later than the moment");
  const rows = await history.jsonl(`recording/${safeSegment(input.source.agentSlug)}/wake-moments.jsonl`, wakeSnapshotRowSchema);
  if (!rows?.some((row) => compareInstants(row.started_at, manifest.started_at) === 0
    && row.snapshots.some((entry) => entry.id === input.id && entry.snapshot === input.source.snapshot))) {
    throw new Error("Selected snapshot has no matching wake row");
  }
  report.checked.snapshots++;
  for (const detail of await snapshotTreeFindings(retained, manifest, { retained: true })) addInputFinding(report, input, "snapshot", `Retained ${detail}`);
  for (const detail of await snapshotTreeFindings(directory, manifest, {
    readBytes: async (name) => readFile(await diskPath(root, `${input.path}/${name}`)),
    expectedBytes: (name) => snapshotBytes(history, relative, name)
  })) addInputFinding(report, input, "snapshot", detail);
};
