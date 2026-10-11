import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { acquirePidLock, bindDeploymentRecording, deployResourceLogPath, readDeployResources,
  readDeploymentRecord, type DeploymentRecord } from "../deployment/index.js";
import { publishDeploymentRecord } from "../deployment/recordPublication.js";
import { acquireFeedLock, readFeedLanded, readFeedLandings, refreshVolumeFeed } from "../volume/index.js";
import { createFeedFixture, writeSourceFiles, type FeedFixture } from "../volume/feedTestKit.js";
import { syncDeploymentMoments } from "./deployment.js";
import { agent, execFor, now, wake } from "./fixtures.test-helper.js";
import { deploymentMomentsDirectory } from "./store.js";
import type { MomentRecord } from "./types.js";

vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>() }));
let root: string, fixture: FeedFixture | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "record-deployment-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now());
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); fixture?.cleanup(); fixture = undefined; fs.rmSync(root, { recursive: true, force: true }); });
const instant = (minute: string) => `2026-10-09T08:${minute}:00.000Z`;
const file = () => path.join(root, "news.json");
const facts = () => ({ ...agent, memory: [], snapshots: [], networks: [], feeds: [], resources: [] });
const record = (minute: string, recordingAgent = facts()): DeploymentRecord => ({
  version: "spawnfile.deployment.v2", name: "news", manager: "docker", compile_fingerprint: "fingerprint",
  created_at: instant(minute), activated_at: instant(minute), activation_exact: true,
  auth_profile: null, output_directory: root, source: { kind: "project", root }, target: { kind: "host", value: "unix:///test.sock" },
  recording: { keep_ms: agent.keep_ms, memory_mount_ids: [], agents: [recordingAgent] },
  units: [{ id: "org", kind: "container", container_id: "container", container_name: "container", image_id: "image", image_tag: "image:v1",
    contains: [{ id: agent.node_id, kind: "agent" }], runtime_instances: ["daimon-organization"] }]
});
const moments = (): MomentRecord[] => fs.readdirSync(path.join(deploymentMomentsDirectory(file()), agent.slug))
  .filter((name) => name.endsWith(".json")).sort().map((name) => JSON.parse(fs.readFileSync(
    path.join(deploymentMomentsDirectory(file()), agent.slug, name), "utf8")) as MomentRecord);
const sync = async (selected: DeploymentRecord) => syncDeploymentMoments({ record: selected, recordPath: file() }, {
  now,
  inspectDockerDeployment: async () => new Map([["org", {
    containerId: "container", drift: [], exists: true, exitCode: null, finishedAt: null, identity: null, imageId: "image",
    message: "", restartCount: 0, running: true, severity: "ok", startedAt: null, status: null, unitId: "org"
  }]]),
  createDockerProbeGateway: () => ({ exec: execFor(["05", "10", "20"].map((minute) => ({ ...wake(instant(minute)), snapshots: [] }))),
    httpGet: vi.fn(), inspectUnit: vi.fn() })
});
const failAppend = (log: string) => {
  const open = fs.openSync;
  return vi.spyOn(fs, "openSync").mockImplementation((name, ...args) => {
    if (name === log && args[0] !== "r") throw new Error("B append failed");
    return open(name, ...args);
  });
};
const modes = ["recovered", "busy", "append-fails"] as const;

it.each(modes)("sync after deployment B append failure: %s, before any publisher retry", async (mode) => {
  const publish = async (minute: string, pin: string) => {
    const value = record(minute);
    value.recording!.agents![0]!.resources = [{ id: "archive", kind: "git" }];
    const report = { recording: value.recording, workspace_git_resources: [{ id: "archive", agent_node_ids: [agent.node_id],
      commit: pin.repeat(40), sha256: `sha256:${pin.repeat(64)}` }] };
    await publishDeploymentRecord(file(), bindDeploymentRecording(file(), value, report, JSON.stringify(report)));
  };
  await publish("00", "a");
  await publish("10", "a");
  const selectedBeforeB = await readDeploymentRecord(file());
  const failure = failAppend(deployResourceLogPath(file()));
  await expect(publish("15", "b")).rejects.toThrow("B append failed");
  expect((await readDeploymentRecord(file())).resource_snapshot!.resources[0]).toMatchObject({ commit: "b".repeat(40) });
  expect(readDeployResources(file()).entries.at(-1)!.resources[0]).toMatchObject({ commit: "a".repeat(40) });
  if (mode !== "append-fails") failure.mockRestore();
  const release = mode === "busy" ? await acquirePidLock(`${file()}.resource-log.lock`) : undefined;
  try {
    expect(await sync(selectedBeforeB)).toMatchObject({ written: 3, nonExact: mode === "recovered" ? 0 : 2, failures: [] });
  } finally { await release?.(); }
  const [early, boundary, late] = moments();
  expect(early).toMatchObject({ exact: true, resources: [{ commit: "a".repeat(40) }] });
  if (mode === "recovered") {
    expect(late).toMatchObject({ exact: true, resources: [{ commit: "b".repeat(40) }] });
    expect(readDeployResources(file()).entries.at(-1)).toEqual((await readDeploymentRecord(file())).resource_snapshot);
  } else {
    for (const moment of [boundary, late]) expect(moment).toMatchObject({ exact: false,
      errors: expect.arrayContaining(["Deploy history publication pending"]) });
  }
});

it.each(modes)("sync after feed B append failure: %s, before any refresh retry", async (mode) => {
  fixture = createFeedFixture({ record: { keepMs: agent.keep_ms } });
  const feed = fixture;
  const value = record("00");
  value.recording!.agents![0]!.feeds = [{ id: feed.target.resourceId, volume_name: feed.target.volumeName }];
  await publishDeploymentRecord(file(), bindDeploymentRecording(file(), value, { recording: value.recording }, "report"));
  refreshVolumeFeed(feed.target, { now: () => new Date(instant("00")) });
  writeSourceFiles(feed.source, { "a.txt": "A\n" });
  refreshVolumeFeed(feed.target, { now: () => new Date(instant("10")) });
  const predecessor = readFeedLandings(feed.target.stateDir).entries.at(-1)!;
  writeSourceFiles(feed.source, { "a.txt": "B\n" });
  const failure = failAppend(path.join(feed.target.stateDir, "landings.jsonl"));
  expect(() => refreshVolumeFeed(feed.target, { now: () => new Date(instant("15")) })).toThrow("B append failed");
  const pending = readFeedLanded(feed.target.stateDir).record!.recording!.landing;
  expect(pending.revision).not.toBe(predecessor.revision);
  expect(readFeedLandings(feed.target.stateDir).entries.at(-1)).toEqual(predecessor);
  if (mode !== "append-fails") failure.mockRestore();
  vi.spyOn(childProcess, "execFileSync").mockImplementation(() => Buffer.from(feed.volume));
  const lock = mode === "busy" ? acquireFeedLock(feed.target.stateDir) : undefined;
  try {
    expect(await sync(await readDeploymentRecord(file()))).toMatchObject({ written: 3, nonExact: mode === "recovered" ? 1 : 2, failures: [] });
  } finally { lock?.release(); }
  const [early, boundary, late] = moments();
  expect(early!.exact).toBe(true);
  if (mode === "recovered") {
    expect(late).toMatchObject({ exact: true, feeds: [{ revision: pending.revision }] });
    expect(readFeedLandings(feed.target.stateDir).entries.at(-1)).toEqual(pending);
  } else {
    for (const moment of [boundary, late]) expect(moment).toMatchObject({ exact: false,
      errors: expect.arrayContaining([`Feed ${feed.target.resourceId}: history publication pending`]) });
  }
});
