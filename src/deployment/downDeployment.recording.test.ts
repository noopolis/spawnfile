import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildDistributionReport } from "../distribution/index.js";
import { writeUtf8File } from "../filesystem/index.js";
import type { CompileReport } from "../report/index.js";
import { REPORT_FILENAME } from "../shared/index.js";

import { downDeployment } from "./downDeployment.js";
import { writeHomeDeployment } from "./homeStore.js";
import { writeDeploymentRecord, type DeploymentRecord } from "./record.js";

const originalHome = process.env.SPAWNFILE_HOME;
let root = "";
const recording = { keep_ms: 30 * 86_400_000, memory_mount_ids: ["memory-recall"] };
const record = (): DeploymentRecord => ({
  auth_profile: null,
  compile_fingerprint: "sf1:recording",
  created_at: "2026-10-11T00:00:00.000Z",
  manager: "docker",
  name: "recorded",
  output_directory: root,
  source: { kind: "project", root },
  target: { endpoint_fingerprint: `sha256:${"a".repeat(32)}`, kind: "context", name: "default" },
  units: [{
    container_id: "container-123",
    container_name: "spawnfile-recorded",
    contains: [{ id: "agent:one", kind: "agent" }],
    id: "organization",
    image_id: "image-123",
    image_tag: "project:latest",
    kind: "container",
    runtime_instances: ["agent-one"],
  }],
  version: "spawnfile.deployment.v2",
});
const compileReport = (enabled = true, declared = false): CompileReport => ({
  compile_fingerprint: "sf1:recording",
  container: {
    dockerfile: "Dockerfile",
    entrypoint: "entrypoint",
    env_example: ".env.example",
    model_secrets_required: [],
    persistent_mounts: [{
      id: "memory-recall",
      mount_path: "/memory",
      reason: "durable memory store",
      volume_name: "recorded-memory",
      ...(declared ? { declared_volume_name: "recorded-memory" } : {}),
    }, {
      id: "workspace",
      mount_path: "/workspace",
      reason: "workspace resource",
      volume_name: "recorded-workspace",
    }],
    ports: [],
    runtime_homes: [],
    runtime_instances: [],
    runtime_secrets_required: [],
    runtimes_installed: [],
    secrets_required: [],
  },
  diagnostics: [],
  nodes: [],
  root,
  spawnfile_version: "0.1",
  ...(enabled ? { recording } : {}),
});
const setupProject = async (enabled = true, declared = false): Promise<void> => {
  await writeDeploymentRecord(root, { ...record(), ...(enabled ? { recording } : {}) });
  await writeUtf8File(path.join(root, REPORT_FILENAME), JSON.stringify(compileReport(enabled, declared)));
};
const setupImage = async (enabled = true) => {
  const report = buildDistributionReport({
    envVariables: [], generatedAt: "2026-10-11T00:00:00.000Z", internalPorts: [],
    modelAuthMethods: {}, moltnetNetworks: [], organization: { agents: [], project: "image", teams: [] },
    persistentMounts: [{ durability: "persistent", id: "memory-recall", kind: "volume", target: "/memory" }],
    portMappings: [], publishedPorts: [], resources: [], runtimeInstances: [],
    ...(enabled ? { recording } : {}),
  });
  await writeHomeDeployment({ ...record(), compile_fingerprint: report.compile_fingerprint,
    output_directory: null, source: { kind: "image", ref: "org/image:v1", digest: null } }, report);
  return vi.fn(async (_file: string, args: string[]) => ({ stderr: "", stdout: args.includes("inspect")
    ? ["container-123", "/spawnfile-recorded", "image-123", {
      "com.spawnfile.deployment": "recorded",
      "com.spawnfile.compile_fingerprint": report.compile_fingerprint,
      "com.spawnfile.unit": "organization",
    }].map((value) => JSON.stringify(value)).join("\n")
    : "" }));
};

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-recorded-memory-"));
  process.env.SPAWNFILE_HOME = path.join(root, "home");
});
afterEach(async () => {
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  await rm(root, { force: true, recursive: true });
});

describe("recorded memory teardown", () => {
  it("refuses project --volumes before export or teardown even with --force", async () => {
    await setupProject();
    const execFile = vi.fn(async () => ({ stderr: "", stdout: "" }));
    await expect(downDeployment({ compiledOutputDirectory: root, deploymentName: "recorded", execFile,
      exportTo: path.join(root, "export"), force: true, removeVolumes: true,
    })).rejects.toThrow("--discard-recorded-memory");
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([false, true])("allows project removal with recording=%s and explicit override only when on", async (enabled) => {
    await setupProject(enabled);
    const execFile = vi.fn(async () => ({ stderr: "", stdout: "" }));
    const receipt = await downDeployment({ compiledOutputDirectory: root, deploymentName: "recorded", execFile,
      force: true, removeVolumes: true, ...(enabled ? { discardRecordedMemory: true } : {}),
    });
    expect(receipt.errors).toEqual([]);
    expect(receipt.retained_volumes).toEqual([]);
    expect(execFile).toHaveBeenCalledWith("docker", ["--context", "default", "volume", "rm", "-f", "recorded-memory"], expect.anything());
  });

  it("retains protected memory without --volumes and still stops containers", async () => {
    await setupProject();
    const execFile = vi.fn(async () => ({ stderr: "", stdout: "" }));
    const receipt = await downDeployment({ compiledOutputDirectory: root, deploymentName: "recorded", execFile, force: true });
    expect(receipt.retained_volumes).toContain("recorded-memory");
    expect(receipt.units_stopped).toEqual(["organization"]);
    expect(execFile.mock.calls).toHaveLength(1);
  });

  it("preserves ordinary teardown after recompilation when neither deployment nor report records", async () => {
    await setupProject(false);
    await writeUtf8File(path.join(root, REPORT_FILENAME), JSON.stringify({ ...compileReport(false), compile_fingerprint: "sf1:recompiled" }));
    const execFile = vi.fn(async () => ({ stderr: "", stdout: "" }));
    const receipt = await downDeployment({ compiledOutputDirectory: root, deploymentName: "recorded", execFile,
      force: true, removeVolumes: true });
    expect(receipt.errors).toEqual([]);
    expect(receipt.retained_volumes).toEqual([]);
  });

  it("leaves declared memory names retained and permits deleting unrelated owned volumes", async () => {
    await setupProject(true, true);
    const execFile = vi.fn(async () => ({ stderr: "", stdout: "" }));
    const receipt = await downDeployment({ compiledOutputDirectory: root, deploymentName: "recorded", execFile,
      force: true, removeVolumes: true,
    });
    expect(receipt.retained_volumes).toEqual(["recorded-memory"]);
    expect(receipt.skipped_volumes).toEqual(["recorded-memory"]);
  });

  it("refuses image --volumes after identity inspection but before mutation", async () => {
    const execFile = await setupImage();
    await expect(downDeployment({ compiledOutputDirectory: root, deploymentName: "recorded", execFile,
      force: true, removeVolumes: true,
    })).rejects.toThrow("--discard-recorded-memory");
    expect(execFile.mock.calls).toHaveLength(1);
    expect(execFile.mock.calls[0]![1]).toContain("inspect");
  });

  it.each([false, true])("allows image removal with recording=%s and explicit override only when on", async (enabled) => {
    const execFile = await setupImage(enabled);
    const receipt = await downDeployment({ compiledOutputDirectory: root, deploymentName: "recorded", execFile,
      force: true, removeVolumes: true, ...(enabled ? { discardRecordedMemory: true } : {}),
    });
    expect(receipt.errors).toEqual([]);
    expect(receipt.retained_volumes).toEqual([]);
    expect(execFile.mock.calls.some(([, args]) => args.includes("volume") && args.includes("rm"))).toBe(true);
  });
});
