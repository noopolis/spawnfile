import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeDirectory, writeUtf8File } from "../filesystem/index.js";
import type { CompileReport } from "../report/index.js";
import type { RuntimeOperations } from "../runtime/operations.js";
import { REPORT_FILENAME } from "../shared/index.js";

import { exportRunArtifacts } from "./artifactsExport.js";
import { planArtifactExports } from "./artifactsExportPlan.js";
import { downDeployment } from "./downDeployment.js";
import { resolveDeploymentRecordPath } from "./names.js";
import { writeDeploymentRecord, type DeploymentRecord } from "./record.js";
import { withSyntheticAdapter } from "./syntheticRuntimeAdapter.test-helper.js";

const RUNTIME = "synthetic-runtime";
const LEDGER = "raw/synthetic/ledger.jsonl";
const PRIVATE = "private/synthetic";
const roots: string[] = [];
const originalHome = process.env.SPAWNFILE_HOME;

const temp = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

beforeEach(async () => { process.env.SPAWNFILE_HOME = await temp("spawnfile-adapters-home-"); });
afterEach(async () => {
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  await Promise.all(roots.splice(0).map((directory) => removeDirectory(directory)));
});

const record: DeploymentRecord = {
  auth_profile: null, compile_fingerprint: "sf1:synthetic", created_at: "2026-07-11T00:00:00.000Z", manager: "docker",
  name: "default", output_directory: "/project/.spawn", run_id: "run-synthetic", source: { kind: "project", root: "/project" },
  target: { endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef", kind: "context", name: "default" },
  units: [{
    container_id: "container-synthetic", container_name: "spawnfile-synthetic", contains: [{ id: "agent:sample", kind: "agent" }],
    id: "default-container", image_id: "image-synthetic", image_tag: "spawnfile-synthetic:latest", kind: "container",
    runtime_instances: ["agent-sample"]
  }],
  version: "spawnfile.deployment.v2"
};

const report = (runtime: string): CompileReport => ({
  container: {
    dockerfile: "container/Dockerfile", entrypoint: "container/entrypoint", env_example: "container/.env.example",
    model_secrets_required: [], ports: [], runtime_homes: [], runtime_secrets_required: [], runtimes_installed: [runtime],
    secrets_required: [],
    runtime_instances: [{
      config_path: "/agents/sample/config", home_path: null, id: "agent-sample", model_auth_methods: {},
      model_secrets_required: [], node_ids: ["agent:sample"], runtime
    }]
  },
  diagnostics: [], nodes: [], root: "/project", spawnfile_version: "0.1"
}) as CompileReport;

const operations: RuntimeOperations = {
  exportFiles: () => [{ optional: false, relativePath: LEDGER, source: { kind: "volume", volumeName: "synthetic-volume", volumePath: "ledger.jsonl" } }],
  privateExportDirectories: () => [{ containerPath: "/synthetic/private", relativePath: PRIVATE }]
};

/** Fake Docker: records every call; `cp` writes deterministic content unless its source is listed as failing. */
const fakeDocker = (fail: string[] = [], content = "fresh") => {
  const calls: string[][] = [];
  const execFile = async (_file: string, args: string[]) => {
    calls.push(args);
    if (args.includes("cp")) {
      const source = args[args.indexOf("cp") + 1]!;
      const destination = args[args.indexOf("cp") + 2]!;
      if (fail.some((needle) => source.includes(needle))) throw new Error("no such file");
      if (source.endsWith("/synthetic/private")) {
        await mkdir(destination, { recursive: true });
        await writeFile(path.join(destination, "trace.json"), `${content}\n`);
      } else {
        await writeFile(destination, `${content}\n`);
      }
    }
    return { stderr: "", stdout: "" };
  };
  return { calls, execFile };
};

const setup = async (runtime: string, overrides: Partial<DeploymentRecord> = {}) => {
  const compiled = await temp("spawnfile-adapters-compiled-");
  const destination = await temp("spawnfile-adapters-out-");
  await writeDeploymentRecord(compiled, { ...record, ...overrides });
  await writeUtf8File(path.join(compiled, REPORT_FILENAME), JSON.stringify(report(runtime)));
  const recordBytes = () => readFile(resolveDeploymentRecordPath(compiled, "default"), "utf8");
  return { compiled, destination, recordBytes };
};

describe("artifacts export adapter requirements", () => {
  it("refuses an absent adapter before planning, Docker, index or marker", async () => {
    const { compiled, destination, recordBytes } = await setup("absent-runtime");
    const before = await recordBytes();
    const docker = fakeDocker();
    expect(() => planArtifactExports(report("absent-runtime"))).toThrow(/"absent-runtime".*--adapter <module>/u);
    await expect(exportRunArtifacts({ compiledOutputDirectory: compiled, deploymentName: "default", destinationDirectory: destination, execFile: docker.execFile }))
      .rejects.toThrow(/--adapter <module>/u);
    expect(docker.calls).toEqual([]);
    expect(await readdir(destination)).toEqual([]);
    expect(await recordBytes()).toBe(before);
  });

  it("exports a loaded adapter that legitimately has no export hooks", async () => {
    const { compiled, destination } = await setup(RUNTIME);
    const result = await withSyntheticAdapter(RUNTIME, () =>
      exportRunArtifacts({ compiledOutputDirectory: compiled, deploymentName: "default", destinationDirectory: destination, execFile: fakeDocker().execFile }));
    expect(result).toMatchObject({ failedFiles: [], index: { files: [] } });
    await expect(readFile(result.indexPath, "utf8")).resolves.toContain("run-synthetic");
    expect(await readdir(destination)).toEqual(["spawnfile"]);
  });

  it("promotes required and private files and stamps the marker on success", async () => {
    const { compiled, destination } = await setup(RUNTIME);
    const result = await withSyntheticAdapter(RUNTIME, () => exportRunArtifacts({
      compiledOutputDirectory: compiled, deploymentName: "default", destinationDirectory: destination,
      execFile: fakeDocker().execFile, includePrivate: true
    }), { operations });
    expect(result.index.files.map((file) => file.path)).toEqual([`${PRIVATE}/trace.json`, LEDGER]);
    await expect(readFile(path.join(destination, ...LEDGER.split("/")), "utf8")).resolves.toBe("fresh\n");
    await expect(readFile(path.join(destination, PRIVATE, "trace.json"), "utf8")).resolves.toBe("fresh\n");
    expect((await readdir(destination)).sort()).toEqual(["private", "raw", "spawnfile"]);
    await expect(readFile(resolveDeploymentRecordPath(compiled, "default"), "utf8")).resolves.toContain(result.indexPath);
  });

  it("keeps an earlier successful export intact when a retry fails a required file", async () => {
    const { compiled, destination, recordBytes } = await setup(RUNTIME);
    const first = await withSyntheticAdapter(RUNTIME, () => exportRunArtifacts({
      compiledOutputDirectory: compiled, deploymentName: "default", destinationDirectory: destination, execFile: fakeDocker([], "first").execFile
    }), { operations });
    const marked = await recordBytes();
    const firstIndex = await readFile(first.indexPath, "utf8");
    const retry = await withSyntheticAdapter(RUNTIME, () => exportRunArtifacts({
      compiledOutputDirectory: compiled, deploymentName: "default", destinationDirectory: destination, execFile: fakeDocker(["ledger.jsonl"], "second").execFile
    }), { operations });
    expect(retry.failedFiles).toEqual([LEDGER]);
    expect(await recordBytes()).toBe(marked);
    await expect(readFile(first.indexPath, "utf8")).resolves.toBe(firstIndex);
    await expect(readFile(path.join(destination, ...LEDGER.split("/")), "utf8")).resolves.toBe("first\n");
    expect((await readdir(destination)).sort()).toEqual(["raw", "spawnfile"]);
  });

  it("does not mark a requested private directory that cannot be read as exported", async () => {
    const { compiled, destination, recordBytes } = await setup(RUNTIME);
    const before = await recordBytes();
    const result = await withSyntheticAdapter(RUNTIME, () => exportRunArtifacts({
      compiledOutputDirectory: compiled, deploymentName: "default", destinationDirectory: destination,
      execFile: fakeDocker(["/synthetic/private"]).execFile, includePrivate: true
    }), { operations });
    expect(result.failedFiles).toEqual([PRIVATE]);
    expect(await recordBytes()).toBe(before);
    expect(await readdir(destination)).toEqual([]);
  });
});

describe("down --export-to adapter requirements", () => {
  const removals = (calls: string[][]) => calls.filter((args) => args.includes("rm") && args.includes("container-synthetic"));

  it("refuses an absent adapter without exporting or removing the container", async () => {
    const { compiled, destination, recordBytes } = await setup("absent-runtime");
    const before = await recordBytes();
    const docker = fakeDocker();
    await expect(downDeployment({ compiledOutputDirectory: compiled, deploymentName: "default", execFile: docker.execFile, exportTo: destination }))
      .rejects.toThrow(/before teardown.*--adapter <module>/u);
    expect(docker.calls).toEqual([]);
    expect(await recordBytes()).toBe(before);
    expect(await readdir(destination)).toEqual([]);
  });

  it("keeps the container when a required file fails to export", async () => {
    const { compiled, destination, recordBytes } = await setup(RUNTIME);
    const before = await recordBytes();
    const docker = fakeDocker(["ledger.jsonl"]);
    await expect(withSyntheticAdapter(RUNTIME, () => downDeployment({
      compiledOutputDirectory: compiled, deploymentName: "default", execFile: docker.execFile, exportTo: destination
    }), { operations })).rejects.toThrow(/was not torn down.*ledger\.jsonl.*container was kept/u);
    expect(removals(docker.calls)).toEqual([]);
    expect(await recordBytes()).toBe(before);
  });

  it("exports and then tears down when the adapter is loaded", async () => {
    const { compiled, destination } = await setup(RUNTIME);
    const docker = fakeDocker();
    const receipt = await withSyntheticAdapter(RUNTIME, () => downDeployment({
      compiledOutputDirectory: compiled, deploymentName: "default", execFile: docker.execFile, exportTo: destination
    }), { operations });
    expect(receipt).toMatchObject({ errors: [], units_stopped: ["default-container"] });
    expect(removals(docker.calls)).toHaveLength(1);
    await expect(readFile(path.join(destination, ...LEDGER.split("/")), "utf8")).resolves.toBe("fresh\n");
  });

  it("still lets --force discard deliberately without an adapter", async () => {
    const { compiled } = await setup("absent-runtime");
    const docker = fakeDocker();
    const receipt = await downDeployment({ compiledOutputDirectory: compiled, deploymentName: "default", execFile: docker.execFile, force: true });
    expect(receipt.units_stopped).toEqual(["default-container"]);
  });
});
