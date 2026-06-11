import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureDirectory, removeDirectory, writeUtf8File } from "../filesystem/index.js";
import { REPORT_FILENAME } from "../shared/index.js";
import { loadCompileReport } from "./compileReport.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

const createOutputDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-status-report-"));
  temporaryDirectories.push(directory);
  return directory;
};

describe("status compile report loader", () => {
  it("treats a missing report as unknown-ready state", async () => {
    const directory = await createOutputDirectory();

    await expect(loadCompileReport(directory)).resolves.toEqual({
      kind: "missing",
      reportPath: path.join(directory, REPORT_FILENAME)
    });
  });

  it("loads old and new report fields defensively", async () => {
    const directory = await createOutputDirectory();
    await writeUtf8File(path.join(directory, REPORT_FILENAME), `${JSON.stringify({
      compile_fingerprint: "sf1:abc",
      container: {
        secrets_required: ["OPENAI_API_KEY"],
        runtime_instances: [
          "bad-runtime-entry",
          {
            config_path: "/config/openclaw.json",
            home_path: "/home/openclaw",
            id: "agent-analyst",
            internal_port: 18789,
            node_ids: ["agent:analyst"],
            published_port: 18789,
            runtime: "openclaw",
            workspace_path: "/workspace"
          },
          {
            id: "missing-runtime"
          }
        ]
      },
      diagnostics: [],
      generated_at: "2026-06-11T00:00:00.000Z",
      nodes: [
        "bad-node-entry",
        {
          capabilities: [
            "bad-capability-entry",
            { key: "agent.schedule", message: "native", outcome: "supported" },
            { key: "bad", message: "bad", outcome: "maybe" }
          ],
          diagnostics: [
            "bad-diagnostic-entry",
            { level: "info", message: "compiled" },
            { level: "debug", message: "ignored" }
          ],
          id: "agent:analyst",
          kind: "agent",
          output_dir: "runtimes/openclaw/agents/analyst",
          runtime: "openclaw"
        },
        {
          capabilities: [],
          diagnostics: [],
          id: "team:ignored",
          kind: "ghost"
        }
      ],
      output_directory: directory,
      root: "/project/Spawnfile",
      spawnfile_version: "0.1"
    })}\n`);

    const result = await loadCompileReport(directory);

    expect(result.kind).toBe("loaded");
    if (result.kind === "loaded") {
      expect(result.report.compileFingerprint).toBe("sf1:abc");
      expect(result.report.secretsRequired).toEqual(["OPENAI_API_KEY"]);
      expect(result.report.runtimeInstances).toEqual([
        {
          configPath: "/config/openclaw.json",
          homePath: "/home/openclaw",
          id: "agent-analyst",
          internalPort: 18789,
          nodeIds: ["agent:analyst"],
          publishedPort: 18789,
          runtime: "openclaw",
          workspacePath: "/workspace"
        }
      ]);
      expect(result.report.nodes).toHaveLength(1);
    }
  });

  it("normalizes optional container metadata and filters malformed entries", async () => {
    const directory = await createOutputDirectory();
    await writeUtf8File(path.join(directory, REPORT_FILENAME), `${JSON.stringify({
      container: {
        internal_ports: [8787, "bad", Number.NaN],
        moltnet: {
          server_plans: [
            "bad-server",
            {
              auth_mode: "open",
              base_url: "http://127.0.0.1:8787",
              direct_messages: false,
              id: "root-local-lab",
              mode: "managed",
              network_id: "local_lab",
              operator_token_secret: "MOLTNET_OPERATOR_TOKEN",
              port: 8787,
              public_read: true,
              rooms: [
                "bad-room",
                {
                  id: "floor",
                  members: ["analyst", 7],
                  visibility: "public",
                  write_policy: "registered"
                },
                { members: ["ignored"] }
              ],
              store_kind: "sqlite"
            },
            {
              base_url: "http://127.0.0.1:9999",
              id: "missing-network",
              mode: "managed"
            }
          ]
        },
        persistent_mounts: [
          {
            id: "moltnet-state",
            mount_path: "/var/lib/moltnet",
            reason: "moltnet store",
            volume_name: "spawnfile-moltnet-state"
          },
          { id: "missing-fields" }
        ],
        port_mappings: [
          { internal_port: 8787, published_port: 18787 },
          { internal_port: 0, published_port: 18788 },
          { internal_port: "bad", published_port: 18789 }
        ],
        published_ports: [18787, "bad"],
        workspace_resources: [
          {
            backing_path: "/var/lib/spawnfile/resources/project",
            id: "project",
            kind: "git",
            link_path: "/workspace/repos/project",
            mode: "mutable",
            mount: "./repos/project",
            sharing: "copy"
          },
          { id: "missing-fields" }
        ]
      },
      generated_at: "2026-06-11T00:00:00.000Z",
      nodes: [
        {
          id: "team:root",
          kind: "team"
        }
      ],
      output_directory: directory,
      root: "/project/Spawnfile"
    })}\n`);

    const result = await loadCompileReport(directory);

    expect(result.kind).toBe("loaded");
    if (result.kind === "loaded") {
      expect(result.report.internalPorts).toEqual([8787]);
      expect(result.report.publishedPorts).toEqual([18787]);
      expect(result.report.portMappings).toEqual([{ internalPort: 8787, publishedPort: 18787 }]);
      expect(result.report.persistentMounts).toEqual([
        {
          id: "moltnet-state",
          mountPath: "/var/lib/moltnet",
          reason: "moltnet store",
          volumeName: "spawnfile-moltnet-state"
        }
      ]);
      expect(result.report.workspaceResources).toEqual([
        {
          backingPath: "/var/lib/spawnfile/resources/project",
          id: "project",
          kind: "git",
          linkPath: "/workspace/repos/project",
          mode: "mutable",
          mount: "./repos/project",
          sharing: "copy"
        }
      ]);
      expect(result.report.moltnetServers).toEqual([
        {
          authMode: "open",
          baseUrl: "http://127.0.0.1:8787",
          directMessages: false,
          id: "root-local-lab",
          mode: "managed",
          networkId: "local_lab",
          operatorTokenSecret: "MOLTNET_OPERATOR_TOKEN",
          port: 8787,
          publicRead: true,
          rooms: [
            {
              id: "floor",
              members: ["analyst"],
              visibility: "public",
              writePolicy: "registered"
            }
          ],
          storeKind: "sqlite"
        }
      ]);
      expect(result.report.nodes).toEqual([
        expect.objectContaining({
          capabilities: [],
          diagnostics: [],
          id: "team:root",
          kind: "team",
          outputDir: null,
          runtime: null
        })
      ]);
    }
  });

  it("falls back cleanly when legacy container metadata sections are absent", async () => {
    const directory = await createOutputDirectory();
    await writeUtf8File(path.join(directory, REPORT_FILENAME), `${JSON.stringify({
      container: {
        ports: [8787, "bad"],
        runtime_instances: []
      },
      nodes: []
    })}\n`);

    const result = await loadCompileReport(directory);

    expect(result.kind).toBe("loaded");
    if (result.kind === "loaded") {
      expect(result.report.internalPorts).toEqual([]);
      expect(result.report.moltnetServers).toEqual([]);
      expect(result.report.persistentMounts).toEqual([]);
      expect(result.report.portMappings).toEqual([]);
      expect(result.report.publishedPorts).toEqual([8787]);
      expect(result.report.workspaceResources).toEqual([]);
    }
  });

  it("returns an input failure for malformed JSON", async () => {
    const directory = await createOutputDirectory();
    await ensureDirectory(directory);
    await writeUtf8File(path.join(directory, REPORT_FILENAME), "{not json");

    const result = await loadCompileReport(directory);

    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.failure.exitCode).toBe(2);
      expect(result.failure.message).toContain("Unable to read compile report");
    }
  });

  it("returns an input failure for malformed report shape", async () => {
    const directory = await createOutputDirectory();
    await ensureDirectory(directory);
    await writeUtf8File(path.join(directory, REPORT_FILENAME), "{\"nodes\":\"bad\"}\n");

    const result = await loadCompileReport(directory);

    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.failure.exitCode).toBe(2);
      expect(result.failure.message).toContain("Malformed compile report");
    }
  });

  it("returns an input failure when the report path cannot be statted", async () => {
    const directory = await createOutputDirectory();
    const filePath = path.join(directory, "not-a-directory");
    await writeUtf8File(filePath, "not a dir\n");

    const result = await loadCompileReport(filePath);

    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.failure.exitCode).toBe(2);
      expect(result.failure.message).toContain("Unable to stat compile report");
    }
  });
});
