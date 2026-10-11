import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { buildDistributionReport } from "../distribution/index.js";
import { writeHomeDeployment, resolveHomeDeploymentDirectory, resolveHomeReportPath, resolveHomeRecordPath } from "./homeStore.js";
import { createDeployResources, deployResourcesAt, readDeployResources, ensureDeployResources } from "./resourceLog.js";
import type { DeployResourceReport } from "./resourceLog.js";
import type { DeploymentRecord } from "./record.js";

vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }));
const day = 86_400_000;
let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "spawnfile-resource-log-"));
  vi.stubEnv("SPAWNFILE_HOME", home);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(home, { recursive: true, force: true }); });
const pins: DeployResourceReport = {
  recording: { keep_ms: 2 * day, memory_mount_ids: [] },
  workspace_git_resources: [{ id: "archive", agent_node_ids: ["agent:writer"], declared_by: "team:news", commit: "a".repeat(40), sha256: `sha256:${"b".repeat(64)}`, url: "https://example.test/archive.git" }],
  workspace_bundles: [{ id: "tools", agent_node_ids: ["agent:writer"], sha256: `sha256:${"c".repeat(64)}`, origin: "built" }]
};
const record = (date = 10): DeploymentRecord => ({
  name: "news", created_at: `2026-10-${String(date).padStart(2, "0")}T00:00:00.000Z`,
  auth_profile: null, compile_fingerprint: "sf1:test", manager: "docker", output_directory: null,
  source: { kind: "image", ref: "example/news:v1", digest: null },
  target: { kind: "context", name: "default", endpoint_fingerprint: `sha256:${"1".repeat(32)}` },
  units: [{ id: "news-container", kind: "container", container_id: "c1", container_name: "news",
    image_id: "i1", image_tag: "example/news:v1", contains: [], runtime_instances: [] }], version: "spawnfile.deployment.v2"
});
const report = (enabled = true) => buildDistributionReport({
  envVariables: [], generatedAt: record().created_at, internalPorts: [], modelAuthMethods: {}, moltnetNetworks: [],
  organization: { agents: [], teams: [], project: "news" }, persistentMounts: [], portMappings: [], publishedPorts: [],
  resources: [], runtimeInstances: [], ...(enabled ? { recording: pins.recording,
    workspaceGitResources: pins.workspace_git_resources!.map(({ id, commit, sha256, agent_node_ids, declared_by }) => ({ id, commit, sha256, agent_node_ids, declared_by })),
    workspaceBundles: [{ id: "tools", agent_node_ids: ["agent:writer"], sha256: pins.workspace_bundles![0]!.sha256, origin: "built" }] } : {})
});

it("maps fixture report pins without changing resource ids or giving bundles commits", () => {
  const bytes = "exact persisted bytes\n";
  expect(createDeployResources(resolveHomeRecordPath("news"), record(), pins, bytes)).toEqual({
    version: "spawnfile.deploy-resources.v1", deployment: "news", deployment_id: resolveHomeRecordPath("news"), deployed_at: record().created_at,
    activated_at: record().created_at, activation_exact: false, activation_note: "Activation boundary was not recorded",
    report_sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    resources: [{ ...pins.workspace_git_resources![0], kind: "git" }, { ...pins.workspace_bundles![0], kind: "bundle" }]
  });
});

it("logs each successful home deployment publication (including the release write path), hashes cached bytes", async () => {
  await writeHomeDeployment(record(), report());
  const state = resolveHomeDeploymentDirectory("news"), loaded = readDeployResources(resolveHomeRecordPath("news"));
  expect(loaded.errors).toEqual([]);
  expect(loaded.entries).toEqual([createDeployResources(resolveHomeRecordPath("news"), record(), report(), readFileSync(resolveHomeReportPath("news"), "utf8"))]);
  expect(loaded.entries[0]!.resources.map(({ id }) => id)).toEqual(["archive", "tools"]);
  expect(statSync(path.join(state, "resource-log.jsonl")).mode & 0o777).toBe(0o600);
  await writeHomeDeployment(record(), report());
  expect(readDeployResources(resolveHomeRecordPath("news")).entries).toHaveLength(1);
});

it("does not create or read a log or log lock when recording is off", async () => {
  await writeHomeDeployment(record(), report(false));
  expect(existsSync(path.join(resolveHomeDeploymentDirectory("news"), "resource-log.jsonl"))).toBe(false);
  const state = path.join(home, "absent");
  expect(existsSync(state)).toBe(false);
});

it.each(["record.json", "spawnfile-report.json"])("does not log when %s cannot be published", async (name) => {
  const rename = fs.rename;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to).endsWith(`/${name}`)) throw new Error("publication failed");
    await rename(from, to);
  });
  await expect(writeHomeDeployment(record(), report())).rejects.toThrow("publication failed");
  expect(existsSync(path.join(resolveHomeDeploymentDirectory("news"), "resource-log.jsonl"))).toBe(false);
});

it("retains the state at the cutoff and uses inclusive lookup boundaries", async () => {
  const state = resolveHomeDeploymentDirectory("news");
  for (const date of [1, 3, 10]) {
    vi.setSystemTime(new Date(record(date).created_at));
    ensureDeployResources(resolveHomeRecordPath("news"), createDeployResources(resolveHomeRecordPath("news"), record(date), pins, "report"), pins.recording!.keep_ms);
  }
  const { entries } = readDeployResources(resolveHomeRecordPath("news"));
  expect(entries.map((entry) => entry.deployed_at)).toEqual([record(3).created_at, record(10).created_at]);
  expect(deployResourcesAt(entries, resolveHomeRecordPath("news"), record(3).created_at)).toEqual(entries[0]);
  expect(deployResourcesAt(entries, resolveHomeRecordPath("news"), record(8).created_at)).toEqual(entries[0]);
  expect(deployResourcesAt(entries, resolveHomeRecordPath("news"), record(10).created_at)).toEqual(entries[1]);
  expect(deployResourcesAt(entries, resolveHomeRecordPath("news"), new Date(Date.parse(record(3).created_at) - 1))).toBeNull();
  writeFileSync(path.join(state, "resource-log.jsonl"), `not-json\n${JSON.stringify(entries[0])}\n{}\n`);
  expect(readDeployResources(resolveHomeRecordPath("news"))).toEqual({ entries: [entries[0]], errors: ["line 1: invalid JSON or entry", "line 3: invalid JSON or entry"] });
});
