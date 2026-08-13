import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { removeDirectory, writeUtf8File } from "../filesystem/index.js";
import type { CompileReport } from "../report/index.js";
import { REPORT_FILENAME } from "../shared/index.js";

import { exportRunArtifacts } from "./artifactsExport.js";
import { writeDeploymentRecord, type DeploymentRecord } from "./record.js";

const temporaryDirectories: string[] = [];

const createTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

const sha256Hex = (content: string): string => createHash("sha256").update(content, "utf8").digest("hex");

const createRecord = (overrides: Partial<DeploymentRecord> = {}): DeploymentRecord => ({
  auth_profile: null,
  compile_fingerprint: "sf1:abc123",
  created_at: "2026-07-11T00:00:00.000Z",
  manager: "docker",
  name: "default",
  output_directory: "/project/.spawn",
  run_id: "run-abc123",
  source: { kind: "project", root: "/project" },
  target: { endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef", kind: "context", name: "default" },
  units: [
    {
      container_id: "container-123",
      container_name: "spawnfile-project",
      contains: [{ id: "agent:eleanor", kind: "agent" }],
      id: "default-container",
      image_id: "image-123",
      image_tag: "spawnfile-project:latest",
      kind: "container",
      runtime_instances: ["agent-eleanor"]
    }
  ],
  version: "spawnfile.deployment.v2",
  ...overrides
});

const createReport = (): CompileReport => ({
  container: {
    dockerfile: "container/Dockerfile",
    entrypoint: "container/entrypoint",
    env_example: "container/.env.example",
    memory: [
      {
        accessible_node_ids: ["agent:eleanor"],
        consolidation: { mode: "disabled" },
        declaring_node_id: "team:root",
        id: "office-recall",
        index: {
          graph: { enabled: false },
          lexical: { enabled: false },
          rerank: { enabled: false },
          vector: { enabled: false }
        },
        retention: { forgetting: "manual" },
        store: { kind: "json", path: "/var/lib/spawnfile/memory/office-recall/office-recall.jsonl", persistent_mount_id: "memory-office-recall" },
        transport_by_node_id: { "agent:eleanor": "direct" }
      }
    ],
    model_secrets_required: [],
    moltnet: {
      node_plans: [],
      server_plans: [
        { base_url: "http://127.0.0.1:8787", id: "root-office_lab", mode: "managed", network_id: "office_lab", rooms: [] }
      ]
    },
    persistent_mounts: [
      {
        id: "moltnet-office_lab-causal",
        mount_path: "/var/lib/spawnfile/moltnet/servers/root-office_lab/causal",
        reason: "managed Moltnet causal event log for office_lab",
        volume_name: "spawnfile-project-moltnet-causal-abc123"
      },
      {
        id: "memory-office-recall",
        mount_path: "/var/lib/spawnfile/memory/office-recall",
        reason: "durable memory stores",
        volume_name: "spawnfile-project-memory-office-recall-abc123"
      },
      {
        id: "agent-eleanor-daimon-telemetry",
        mount_path: "/spawn/instances/eleanor/runtime/agents/eleanor/telemetry",
        reason: "daimon turn/wake causal telemetry for eleanor",
        volume_name: "spawnfile-project-agent-eleanor-daimon-telemetry-abc123"
      }
    ],
    ports: [],
    runtime_homes: [],
    runtime_instances: [
      {
        config_path: "/agents/eleanor/config",
        home_path: "/spawn/instances/eleanor/home",
        id: "agent-eleanor",
        model_auth_methods: {},
        model_secrets_required: [],
        node_ids: ["agent:eleanor"],
        runtime: "pi",
        telemetry_mount_ids: { "agent:eleanor": "agent-eleanor-daimon-telemetry" }
      }
    ],
    runtime_secrets_required: [],
    runtimes_installed: ["pi"],
    secrets_required: []
  },
  diagnostics: [],
  nodes: [],
  root: "/project",
  spawnfile_version: "0.1"
});

/** Fakes a real docker cp/create/rm session: `cp` writes deterministic fixture content
 * to the destination host path based on the source path, `inspect`/`create`/`rm` just
 * succeed. Set `missingSourcePaths` to make a `cp` for a matching source fail (simulating
 * a file genuinely absent from the container/volume). */
const createFakeExecFile = (options: { containerAlive?: boolean; missingSourcePaths?: string[] } = {}) => {
  const containerAlive = options.containerAlive ?? true;
  const missing = options.missingSourcePaths ?? [];
  return async (_file: string, args: string[]): Promise<{ stderr: string; stdout: string }> => {
    if (args.includes("inspect")) {
      if (!containerAlive) {
        throw { stderr: "Error: No such container: spawnfile-project" };
      }
      return { stderr: "", stdout: "[]" };
    }
    if (args.includes("create") || args.includes("rm")) {
      return { stderr: "", stdout: "container-id\n" };
    }
    if (args.includes("cp")) {
      const cpIndex = args.indexOf("cp");
      const source = args[cpIndex + 1]!;
      const destination = args[cpIndex + 2]!;
      if (missing.some((needle) => source.includes(needle))) {
        throw new Error(`no such file: ${source}`);
      }
      await writeFile(destination, `fixture-content-for(${source})\n`, "utf8");
      return { stderr: "", stdout: "" };
    }
    throw new Error(`unexpected docker args: ${JSON.stringify(args)}`);
  };
};

describe("exportRunArtifacts", () => {
  it("exports every planned file, computes sha256/bytes, and writes a conformant export-index.json", async () => {
    const compiledOutputDirectory = await createTempDirectory("spawnfile-artifacts-export-compiled-");
    const destinationDirectory = await createTempDirectory("spawnfile-artifacts-export-out-");
    await writeDeploymentRecord(compiledOutputDirectory, createRecord());
    await writeUtf8File(
      path.join(compiledOutputDirectory, REPORT_FILENAME),
      JSON.stringify(createReport())
    );

    const result = await exportRunArtifacts({
      compiledOutputDirectory,
      deploymentName: "default",
      destinationDirectory,
      execFile: createFakeExecFile()
    });

    expect(result.deploymentName).toBe("default");
    expect(result.failedFiles).toEqual([]);
    expect(result.missingOptionalFiles).toEqual([]);
    expect(result.index.version).toBe("spawnfile.export-index.v1");
    expect(result.index.run_id).toBe("run-abc123");
    expect(result.index.deployment).toBe("default");

    const relativePaths = result.index.files.map((file) => file.path).sort();
    expect(relativePaths).toEqual([
      "raw/daimon/eleanor/causal.jsonl",
      "raw/mneme/office-recall/causal.jsonl",
      "raw/mneme/office-recall/events.jsonl",
      "raw/moltnet/causal.jsonl",
      "raw/moltnet/transcript.json"
    ]);

    for (const file of result.index.files) {
      const hostPath = path.join(destinationDirectory, ...file.path.split("/"));
      const content = await readFile(hostPath, "utf8");
      expect(file.sha256).toBe(sha256Hex(content));
      expect(file.bytes).toBe(Buffer.byteLength(content, "utf8"));
    }

    const indexOnDisk = JSON.parse(await readFile(result.indexPath, "utf8"));
    expect(indexOnDisk).toEqual(result.index);
  });

  it("treats a missing optional file (e.g. a bank with no causal events yet) as a skip, not a failure", async () => {
    const compiledOutputDirectory = await createTempDirectory("spawnfile-artifacts-export-compiled-");
    const destinationDirectory = await createTempDirectory("spawnfile-artifacts-export-out-");
    await writeDeploymentRecord(compiledOutputDirectory, createRecord());
    await writeUtf8File(path.join(compiledOutputDirectory, REPORT_FILENAME), JSON.stringify(createReport()));

    const result = await exportRunArtifacts({
      compiledOutputDirectory,
      deploymentName: "default",
      destinationDirectory,
      execFile: createFakeExecFile({ missingSourcePaths: ["memory/causal.jsonl"] })
    });

    expect(result.missingOptionalFiles).toEqual(["raw/mneme/office-recall/causal.jsonl"]);
    expect(result.failedFiles).toEqual([]);
    expect(result.index.files.map((file) => file.path)).not.toContain("raw/mneme/office-recall/causal.jsonl");
  });

  it("resolves the deployment by --run-id when --deployment is not given", async () => {
    const compiledOutputDirectory = await createTempDirectory("spawnfile-artifacts-export-compiled-");
    const destinationDirectory = await createTempDirectory("spawnfile-artifacts-export-out-");
    await writeDeploymentRecord(compiledOutputDirectory, createRecord({ name: "other", run_id: "run-xyz789" }));
    await writeUtf8File(path.join(compiledOutputDirectory, REPORT_FILENAME), JSON.stringify(createReport()));

    const result = await exportRunArtifacts({
      compiledOutputDirectory,
      destinationDirectory,
      execFile: createFakeExecFile(),
      runId: "run-xyz789"
    });

    expect(result.deploymentName).toBe("other");
    expect(result.index.run_id).toBe("run-xyz789");
  });

  it("exports every planned file from durable volumes even when the deployment's container is already gone (Piece 4b: down before export)", async () => {
    const compiledOutputDirectory = await createTempDirectory("spawnfile-artifacts-export-compiled-");
    const destinationDirectory = await createTempDirectory("spawnfile-artifacts-export-out-");
    await writeDeploymentRecord(compiledOutputDirectory, createRecord());
    await writeUtf8File(path.join(compiledOutputDirectory, REPORT_FILENAME), JSON.stringify(createReport()));

    // Every planned source in createReport() (moltnet, mneme, and now daimon telemetry)
    // is volume-sourced, so a gone container ("inspect" fails) must not block the export:
    // this is the concrete proof of the export-before-teardown relaxation Piece 4b buys —
    // `spawnfile down` (no --volumes) then `spawnfile artifacts export` still recovers
    // everything, including daimon's turn/wake causal telemetry, from the named volumes.
    const result = await exportRunArtifacts({
      compiledOutputDirectory,
      deploymentName: "default",
      destinationDirectory,
      execFile: createFakeExecFile({ containerAlive: false })
    });

    expect(result.failedFiles).toEqual([]);
    expect(result.missingOptionalFiles).toEqual([]);
    expect(result.index.files.map((file) => file.path).sort()).toEqual([
      "raw/daimon/eleanor/causal.jsonl",
      "raw/mneme/office-recall/causal.jsonl",
      "raw/mneme/office-recall/events.jsonl",
      "raw/moltnet/causal.jsonl",
      "raw/moltnet/transcript.json"
    ]);
  });

  it("still fails loudly when a legacy (pre-Piece-4b) report needs a live container that is already gone", async () => {
    const compiledOutputDirectory = await createTempDirectory("spawnfile-artifacts-export-compiled-");
    const destinationDirectory = await createTempDirectory("spawnfile-artifacts-export-out-");
    await writeDeploymentRecord(compiledOutputDirectory, createRecord());
    const legacyReport = createReport();
    // Simulate a report compiled before Piece 4b: no telemetry_mount_ids and no matching
    // persistent mount for daimon telemetry, so planDaimonFiles falls back to its
    // container-cp legacy path (see artifactsExportPlan.ts), which genuinely does need a
    // live container.
    legacyReport.container!.persistent_mounts = legacyReport.container!.persistent_mounts!.filter(
      (mount) => mount.id !== "agent-eleanor-daimon-telemetry"
    );
    delete legacyReport.container!.runtime_instances[0]!.telemetry_mount_ids;
    await writeUtf8File(path.join(compiledOutputDirectory, REPORT_FILENAME), JSON.stringify(legacyReport));

    await expect(
      exportRunArtifacts({
        compiledOutputDirectory,
        deploymentName: "default",
        destinationDirectory,
        execFile: createFakeExecFile({ containerAlive: false })
      })
    ).rejects.toThrow(/no live container/);

    // No export-index.json (or raw/) must be written on this path.
    await expect(readFile(path.join(destinationDirectory, "spawnfile", "export-index.json"))).rejects.toThrow();
  });

  it("rejects when both --deployment and --run-id are given", async () => {
    const compiledOutputDirectory = await createTempDirectory("spawnfile-artifacts-export-compiled-");
    const destinationDirectory = await createTempDirectory("spawnfile-artifacts-export-out-");

    await expect(
      exportRunArtifacts({
        compiledOutputDirectory,
        deploymentName: "default",
        destinationDirectory,
        execFile: createFakeExecFile(),
        runId: "run-abc123"
      })
    ).rejects.toThrow(/only one of --deployment or --run-id/);
  });

  it("rejects when neither --deployment nor --run-id is given", async () => {
    const compiledOutputDirectory = await createTempDirectory("spawnfile-artifacts-export-compiled-");
    const destinationDirectory = await createTempDirectory("spawnfile-artifacts-export-out-");

    await expect(
      exportRunArtifacts({ compiledOutputDirectory, destinationDirectory, execFile: createFakeExecFile() })
    ).rejects.toThrow(/requires --deployment/);
  });

  it("gives a clear error when no deployment record exists for the given name", async () => {
    const compiledOutputDirectory = await createTempDirectory("spawnfile-artifacts-export-compiled-");
    const destinationDirectory = await createTempDirectory("spawnfile-artifacts-export-out-");

    await expect(
      exportRunArtifacts({
        compiledOutputDirectory,
        deploymentName: "ghost",
        destinationDirectory,
        execFile: createFakeExecFile()
      })
    ).rejects.toThrow(/No deployment record named "ghost"/);
  });

  it("gives a clear error when no deployment matches the given run id", async () => {
    const compiledOutputDirectory = await createTempDirectory("spawnfile-artifacts-export-compiled-");
    const destinationDirectory = await createTempDirectory("spawnfile-artifacts-export-out-");
    await writeDeploymentRecord(compiledOutputDirectory, createRecord());

    await expect(
      exportRunArtifacts({
        compiledOutputDirectory,
        destinationDirectory,
        execFile: createFakeExecFile(),
        runId: "run-does-not-exist"
      })
    ).rejects.toThrow(/No deployment record found for run id "run-does-not-exist"/);
  });

  it("requires a compile report to be present", async () => {
    const compiledOutputDirectory = await createTempDirectory("spawnfile-artifacts-export-compiled-");
    const destinationDirectory = await createTempDirectory("spawnfile-artifacts-export-out-");
    await writeDeploymentRecord(compiledOutputDirectory, createRecord());

    await expect(
      exportRunArtifacts({
        compiledOutputDirectory,
        deploymentName: "default",
        destinationDirectory,
        execFile: createFakeExecFile()
      })
    ).rejects.toThrow(/No compile report found/);
  });

  it("gives a clear error when the resolved deployment predates run-id tracking", async () => {
    const compiledOutputDirectory = await createTempDirectory("spawnfile-artifacts-export-compiled-");
    const destinationDirectory = await createTempDirectory("spawnfile-artifacts-export-out-");
    const recordWithoutRunId = createRecord();
    delete (recordWithoutRunId as { run_id?: string }).run_id;
    await writeDeploymentRecord(compiledOutputDirectory, recordWithoutRunId);
    await writeUtf8File(path.join(compiledOutputDirectory, REPORT_FILENAME), JSON.stringify(createReport()));

    await expect(
      exportRunArtifacts({
        compiledOutputDirectory,
        deploymentName: "default",
        destinationDirectory,
        execFile: createFakeExecFile()
      })
    ).rejects.toThrow(/has no recorded run id/);
  });
});
