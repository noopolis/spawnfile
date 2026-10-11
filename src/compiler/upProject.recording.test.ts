import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { readDeployResources, readDeploymentRecord, deployResourceLogPath, deployResourcesAt, downDeployment } from "../deployment/index.js";
import { compileProject } from "./compileProject.js";
import { upProject } from "./upProject.js";

const doubles = vi.hoisted(() => ({ build: vi.fn(), invocation: vi.fn() }));
vi.mock("./buildProject.js", async (original) => ({ ...await original<typeof import("./buildProject.js")>(), buildProject: doubles.build }));
vi.mock("./runProjectAuth.js", async (original) => ({ ...await original<typeof import("./runProjectAuth.js")>(), resolveHostCliCredential: async () => null }));
vi.mock("./runProject.js", async (original) => ({
  ...await original<typeof import("./runProject.js")>(), createDockerRunInvocation: doubles.invocation,
  resolveDetachedDeploymentOptions: async (_out: string, options: object) => options
}));
let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "spawnfile-up-recording-"));
  vi.stubEnv("SPAWNFILE_HOME", path.join(root, "home"));
  vi.stubEnv("NOOPOLIS_RUN_ID", "recording-test");
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it.each([false, true])("project up writes a deployment resource entry only with recording=%s", async (recording) => {
  writeFileSync(path.join(root, "Spawnfile"), JSON.stringify({
    spawnfile_version: "0.1", kind: "agent", name: "writer", runtime: "openclaw",
    ...(recording ? { training: { record: {} } } : {})
  }));
  const compiled = await compileProject(root);
  doubles.build.mockResolvedValue({ ...compiled, imageTag: "example/news:v1", organizationReadinessEvidence: undefined });
  doubles.invocation.mockResolvedValue({
    args: [], command: "docker", containerName: "news", detach: true, deploymentName: "news", dockerContext: "local",
    envFilePath: path.join(root, "run.env"), supportDirectory: root, cwd: root
  });
  const runRunner = vi.fn(async () => ({ containerId: "c1", imageId: "i1" }));
  const result = await upProject(root, { detach: true, deploymentName: "news", dockerContext: "local", runRunner,
    targetExecFile: async () => ({ stdout: '"unix:///var/run/docker.sock"\n', stderr: "" }) });
  expect(runRunner).toHaveBeenCalledOnce();
  const state = result.deploymentRecordPath!;
  if (!recording) {
    expect(existsSync(deployResourceLogPath(state))).toBe(false);
    return;
  }
  const record = await readDeploymentRecord(result.deploymentRecordPath!);
  const bytes = await readFile(compiled.reportPath, "utf8");
  expect(readDeployResources(state)).toEqual({ entries: [{
    version: "spawnfile.deploy-resources.v1", deployment: "news", deployed_at: record.created_at,
    deployment_id: state, activated_at: record.activated_at, activation_exact: true,
    report_sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, resources: []
  }], errors: [] });
});

const deploy = async (project: string, keep = "30d", clock = () => new Date()) => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "Spawnfile"), JSON.stringify({ spawnfile_version: "0.1", kind: "agent", name: "writer", runtime: "openclaw",
    memory: [{ id: "self", store: { kind: "json", path: "/data/memory/events.jsonl" } }], training: { record: { keep } } }));
  const compiled = await compileProject(project);
  doubles.build.mockResolvedValue({ ...compiled, imageTag: "example/news:v1", organizationReadinessEvidence: undefined });
  doubles.invocation.mockResolvedValue({ args: [], command: "docker", containerName: "news", detach: true, deploymentName: "default", dockerContext: "local",
    envFilePath: path.join(project, "run.env"), supportDirectory: project, cwd: project });
  const turns: string[] = [];
  const result = await upProject(project, { detach: true, deploymentName: "default", outputDirectory: compiled.outputDirectory,
    now: clock, runRunner: async () => { turns.push(new Date().toISOString()); return { containerId: "c1", imageId: "i1" }; },
    targetExecFile: async () => ({ stdout: '"unix:///var/run/docker.sock"\n', stderr: "" }) });
  return { ...result, turns };
};

it.each([false, true])("deploys recording on, recompiles off (clean=%s), then refuses forced volume deletion without the override", async (clean) => {
  const result = await deploy(root);
  const before = await readDeploymentRecord(result.deploymentRecordPath!);
  expect(before.recording).toEqual(result.report.recording);
  writeFileSync(path.join(root, "Spawnfile"), JSON.stringify({ spawnfile_version: "0.1", kind: "agent", name: "writer", runtime: "openclaw",
    memory: [{ id: "self", store: { kind: "json", path: "/data/memory/events.jsonl" } }] }));
  await compileProject(root, { clean });
  expect((await readDeploymentRecord(result.deploymentRecordPath!)).recording).toEqual(before.recording);
  const execFile = vi.fn(async () => ({ stderr: "", stdout: "" }));
  const options = { compiledOutputDirectory: result.outputDirectory, deploymentName: "default", force: true, removeVolumes: true, execFile };
  await expect(downDeployment(options)).rejects.toThrow("--discard-recorded-memory");
  expect(execFile).not.toHaveBeenCalled();
  expect((await downDeployment({ ...options, discardRecordedMemory: true })).errors).toEqual([]);
  expect(execFile.mock.calls.length).toBeGreaterThan(1);
});

it("keeps two independent default projects' lookup and pruning namespaces separate", async () => {
  const first = await deploy(path.join(root, "one"), "60d");
  const history = readDeployResources(first.deploymentRecordPath!);
  const second = await deploy(path.join(root, "two"), "1m");
  expect(first.deploymentRecordPath).not.toBe(second.deploymentRecordPath);
  expect(readDeployResources(first.deploymentRecordPath!)).toEqual(history);
  const secondHistory = readDeployResources(second.deploymentRecordPath!).entries;
  const mixed = [...history.entries, ...secondHistory];
  const at = new Date(Date.now() + 1000);
  expect(deployResourcesAt(mixed, first.deploymentRecordPath!, at)).toEqual(history.entries[0]);
  expect(deployResourcesAt(mixed, second.deploymentRecordPath!, at)).toEqual(secondHistory[0]);
  expect(deployResourcesAt(mixed, path.join(root, "absent.json"), at)).toBeNull();
});

it("captures activation before a startup turn and marks project replacement overlap explicitly", async () => {
  const order: string[] = [];
  const clock = () => { order.push("activation"); return new Date(); };
  const first = await deploy(root, "30d", clock);
  expect(order).toEqual(["activation"]);
  const entry = deployResourcesAt(readDeployResources(first.deploymentRecordPath!).entries, first.deploymentRecordPath!, first.turns[0]!);
  expect(entry).toMatchObject({ activation_exact: true });
  expect(Date.parse(entry!.activated_at)).toBeLessThanOrEqual(Date.parse(first.turns[0]!));
  const replacement = await deploy(root, "30d", clock);
  const next = readDeployResources(replacement.deploymentRecordPath!).entries.at(-1)!;
  expect(next).toMatchObject({ activation_exact: false, activation_note: expect.stringContaining("overlap") });
});
