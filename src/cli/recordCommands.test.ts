import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createDeployResources, deployResourceLogPath, type DeploymentRecord, type DockerInspectionResult } from "../deployment/index.js";
import type { RecordingAgentReport } from "../report/index.js";
import { deploymentMomentsDirectory } from "../recording/index.js";
import { chunkExec } from "../recording/fixtures.test-helper.js";
import { executeRecordSyncCommand, registerRecordCommands, type RecordCommandHandlers } from "./recordCommands.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "record-command-"));
  for (const file of [path.join(root, "news.json"), path.join(root, "home/news/record.json")]) await writeHistory(file);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const agent: RecordingAgentReport = { node_id: "agent:writer", slug: "writer", directory: "/var/lib/spawnfile/recording/writer",
  keep_ms: 86_400_000, memory: [], networks: [], feeds: [], resources: [], snapshots: [] };
const writeHistory = async (file: string, facts = agent) => {
  await mkdir(path.dirname(file), { recursive: true });
  const entry = createDeployResources(file, { name: "news", created_at: "2026-10-09T00:00:00Z",
    activated_at: "2026-10-09T00:00:00Z", activation_exact: true },
  { recording: { keep_ms: facts.keep_ms, memory_mount_ids: [], agents: [facts] } }, "report");
  await writeFile(deployResourceLogPath(file), `${JSON.stringify(entry)}\n`);
};
const record = (name = "news"): DeploymentRecord => ({
  version: "spawnfile.deployment.v2", name, manager: "docker", compile_fingerprint: "fingerprint", created_at: "2026-10-09T00:00:00Z",
  auth_profile: null, output_directory: root, source: { kind: "project", root }, target: { kind: "host", value: "unix:///var/run/docker.sock" },
  recording: { keep_ms: agent.keep_ms, memory_mount_ids: [], recording_mount_ids: ["daimon-recording-writer"], agents: [agent] },
  units: [{ id: "org", kind: "container", container_id: "container", container_name: "container", image_id: "image", image_tag: "image:v1",
    contains: [{ id: agent.node_id, kind: "agent" }], runtime_instances: ["daimon-organization"] }]
});
const inspection = (running = true): DockerInspectionResult => new Map([["org", {
  containerId: "container", drift: [], exists: true, exitCode: null, finishedAt: null, identity: null, imageId: "image",
  message: "", restartCount: 0, running, severity: "ok", startedAt: null, status: null, unitId: "org"
}]]);
const handlers = (running = true): RecordCommandHandlers => ({
  listDeploymentRecords: vi.fn(async () => [{ path: path.join(root, "news.json"), record: record() }]),
  listHomeDeploymentRecords: vi.fn(async () => [{ path: path.join(root, "home/news/record.json"), record: record() }]),
  inspectDockerDeployment: vi.fn(async () => inspection(running)),
  createDockerProbeGateway: vi.fn(() => ({
    exec: chunkExec(() => JSON.stringify({ version: "noopolis.daimon.wake-moment.v1", agent_id: agent.node_id,
      execution_id: "wake", started_at: "2026-10-09T08:00:00.000Z", deliveries: [{ acceptance_id: "accepted", delivery_id: "wake",
        kind: "manual", occurred_at: "2026-10-09T07:59:00.000Z" }], snapshots: [] })),
    httpGet: vi.fn(), inspectUnit: vi.fn()
  })),
  now: () => new Date("2026-10-09T09:00:00.000Z")
});

it("registers record sync and resolves an explicit project like usage", async () => {
  const program = new Command(), streams = { stdout: vi.fn(), stderr: vi.fn() }, exit = vi.fn(), h = handlers();
  registerRecordCommands(program, streams, exit, h);
  await program.parseAsync(["record", "sync", root, "--deployment", "news"], { from: "user" });
  expect(exit).toHaveBeenCalledWith(0);
  expect(h.listDeploymentRecords).toHaveBeenCalledOnce();
  expect(h.listHomeDeploymentRecords).not.toHaveBeenCalled();
  expect(streams.stdout).toHaveBeenCalledWith("Records: 1 written / 0 skipped / 0 non-exact");
  expect((await readdir(path.join(deploymentMomentsDirectory(path.join(root, "news.json")), "writer"))).filter((name) => name.endsWith(".json")))
    .toHaveLength(1);
});

it("uses the home record for named deployment at default path, without reading current project sources", async () => {
  const h = handlers();
  expect(await executeRecordSyncCommand(process.cwd(), { deployment: "news" }, h)).toMatchObject({ exitCode: 0 });
  expect(h.listHomeDeploymentRecords).toHaveBeenCalledOnce();
  expect(h.listDeploymentRecords).not.toHaveBeenCalled();
  expect(await readdir(path.join(root, "home/news/moments/writer"))).toHaveLength(1);
});

it("uses --out to select project records even from the default path", async () => {
  const h = handlers();
  expect(await executeRecordSyncCommand(process.cwd(), { deployment: "news", out: root }, h)).toMatchObject({ exitCode: 0 });
  expect(h.listDeploymentRecords).toHaveBeenCalledWith(root);
  expect(h.listHomeDeploymentRecords).not.toHaveBeenCalled();
});

it("reports non-exact evidence without failing the command", async () => {
  const h = handlers();
  await writeHistory(path.join(root, "news.json"), { ...agent, feeds: [{ id: "news", volume_name: "news" }] });
  h.listDeploymentRecords = async () => [{ path: path.join(root, "news.json"), record: {
    ...record(), recording: { ...record().recording!, agents: [{ ...agent, feeds: [{ id: "news", volume_name: "news" }] }] }
  } }];
  h.readFeedHistory = async () => { throw new Error("host volume unavailable"); };
  expect(await executeRecordSyncCommand(root, {}, h)).toMatchObject({ exitCode: 0,
    output: "Records: 1 written / 0 skipped / 1 non-exact" });
});

it("fails operationally for a stopped unit, and rejects absent or ambiguous deployment selection", async () => {
  expect(await executeRecordSyncCommand(root, {}, handlers(false))).toMatchObject({ exitCode: 1, error: expect.stringContaining("stopped") });
  const h = handlers();
  h.listDeploymentRecords = async () => [];
  expect(await executeRecordSyncCommand(root, {}, h)).toMatchObject({ exitCode: 2, error: expect.stringContaining("No deployment records") });
  h.listDeploymentRecords = async () => ["news", "another"].map((name) => ({ path: path.join(root, `${name}.json`), record: record(name) }));
  expect(await executeRecordSyncCommand(root, {}, h)).toMatchObject({ exitCode: 2, error: expect.stringContaining("spawnfile record sync requires") });
});

it("does not inspect or read containers when recording is off and refuses legacy recording facts", async () => {
  const h = handlers(), off = record();
  delete off.recording;
  h.listDeploymentRecords = async () => [{ path: path.join(root, "news.json"), record: off }];
  expect(await executeRecordSyncCommand(root, {}, h)).toMatchObject({ exitCode: 0, output: "Records: 0 written / 0 skipped / 0 non-exact" });
  expect(h.inspectDockerDeployment).not.toHaveBeenCalled();
  off.recording = { keep_ms: 1, memory_mount_ids: [] };
  expect(await executeRecordSyncCommand(root, {}, h)).toMatchObject({ exitCode: 1, error: expect.stringContaining("predates") });
});

it("validates timeout before reading deployments", async () => {
  const h = handlers();
  expect(await executeRecordSyncCommand(root, { timeout: "0" }, h)).toMatchObject({ exitCode: 2 });
  expect(h.listDeploymentRecords).not.toHaveBeenCalled();
});
