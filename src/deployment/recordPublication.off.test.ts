import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { buildDistributionReport } from "../distribution/index.js";
import { createDockerDeploymentRecord } from "./dockerManager.js";
import { resolveHomeRecordPath, resolveHomeReportPath, writeHomeDeployment } from "./homeStore.js";
import { resolveDeploymentRecordPath } from "./names.js";
import { writeDeploymentRecord } from "./record.js";

vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }));
let root: string;
beforeEach(() => {
  root = syncFs.mkdtempSync(path.join(os.tmpdir(), "spawnfile-off-baseline-"));
  vi.stubEnv("SPAWNFILE_HOME", root);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); syncFs.rmSync(root, { recursive: true, force: true }); });

// Frozen origin/main publication sequence: one mkdir; plain write + rename per file.
const baseline = async (files: Array<[string, string]>) => {
  await fs.mkdir(path.dirname(files[0]![0]), { recursive: true });
  for (const [file, bytes] of files) {
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(tmp, bytes, "utf8");
    await fs.rename(tmp, file);
  }
};

it.each(["home", "project"])("%s recording-off bytes and filesystem calls equal origin/main on first and repeat publication", async (mode) => {
  const report = buildDistributionReport({ envVariables: [], generatedAt: new Date().toISOString(), internalPorts: [], modelAuthMethods: {}, moltnetNetworks: [],
    organization: { agents: [], teams: [], project: "news" }, persistentMounts: [], portMappings: [], publishedPorts: [], resources: [], runtimeInstances: [],
    workspaceGitResources: [{ id: "archive", agent_node_ids: ["agent:writer"], commit: "a".repeat(40), sha256: `sha256:${"b".repeat(64)}` }],
    workspaceBundles: [{ id: "tools", agent_node_ids: ["agent:writer"], sha256: `sha256:${"c".repeat(64)}`, origin: "prebuilt" }] });
  expect(report.workspace_git_resources).toBeUndefined();
  expect(report.workspace_bundles).toBeUndefined();
  const record = createDockerDeploymentRecord({ authProfileName: null, compileFingerprint: report.compile_fingerprint,
    containerName: "news", imageTag: "example/news:v1", nodes: [], outputDirectory: root, projectRoot: root, runtimeInstanceIds: [],
    target: { kind: "host", value: "unix:///test-only.sock" } });
  const file = mode === "home" ? resolveHomeRecordPath("default") : resolveDeploymentRecordPath(root, "default");
  const files: Array<[string, string]> = [
    ...(mode === "home" ? [[resolveHomeReportPath("default"), `${JSON.stringify(report, null, 2)}\n`] as [string, string]] : []),
    [file, `${JSON.stringify(record, null, 2)}\n`]
  ];
  const events: unknown[] = [];
  for (const name of ["mkdir", "open", "readFile", "writeFile", "rename", "rm", "stat", "access"] as const) {
    const original = fs[name];
    vi.spyOn(fs, name).mockImplementation((...args: unknown[]) => {
      events.push([name, ...args]);
      return Reflect.apply(original, fs, args);
    });
  }
  const syncOpen = vi.spyOn(syncFs, "openSync"), syncRead = vi.spyOn(syncFs, "readFileSync"), sync = vi.spyOn(syncFs, "fsyncSync");
  await baseline(files);
  const expected = [...events];
  await fs.rm(path.dirname(file), { recursive: true, force: true });
  for (const _iteration of [0, 1]) {
    events.length = 0;
    if (mode === "home") await writeHomeDeployment(record, report);
    else await writeDeploymentRecord(root, record);
    expect(events).toEqual(expected);
    expect(syncOpen).not.toHaveBeenCalled();
    expect(syncRead).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    for (const [name, bytes] of files) expect(await fs.readFile(name, "utf8")).toBe(bytes);
  }
});
