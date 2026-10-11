import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { readDeployResources, readDeploymentRecord } from "../deployment/index.js";
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
  const state = path.join(root, "home/deployments/news");
  if (!recording) {
    expect(existsSync(state)).toBe(false);
    return;
  }
  const record = await readDeploymentRecord(result.deploymentRecordPath!);
  const bytes = await readFile(compiled.reportPath, "utf8");
  expect(readDeployResources(state)).toEqual({ entries: [{
    version: "spawnfile.deploy-resources.v1", deployment: "news", deployed_at: record.created_at,
    report_sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, resources: []
  }], errors: [] });
});
