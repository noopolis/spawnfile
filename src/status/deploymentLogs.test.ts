import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeploymentRecord } from "../deployment/index.js";
import type { LoadedCompileReport } from "./compileReport.js";
import { collectDeploymentLogObservations } from "./deploymentLogs.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

const deployment = (): DeploymentRecord => ({
  auth_profile: null,
  compile_fingerprint: "sf1:abc",
  created_at: "2026-06-11T00:00:00.000Z",
  manager: "docker",
  name: "default",
  output_directory: "/project/.spawn",
  source: { kind: "project", root: "/project" },
  target: {
    endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef",
    kind: "context",
    name: "remote"
  },
  units: [
    {
      container_id: "container-123",
      container_name: "project",
      contains: [{ id: "agent:analyst", kind: "agent" }],
      id: "default-container",
      image_id: "image-123",
      image_tag: "project:latest",
      kind: "container",
      runtime_instances: ["agent-analyst"]
    }
  ],
  version: "spawnfile.deployment.v2"
});

const loadedReport = (): LoadedCompileReport => ({
  kind: "loaded",
  report: {
    compileFingerprint: "sf1:abc",
    generatedAt: "2026-06-11T00:00:00.000Z",
    nodes: [],
    outputDirectory: "/project/.spawn",
    reportPath: "/project/.spawn/spawnfile-report.json",
    root: "/project/Spawnfile",
    runtimeInstances: [],
    secretsRequired: ["OPENAI_API_KEY"]
  },
  reportPath: "/project/.spawn/spawnfile-report.json"
});

describe("deployment log observations", () => {
  it("collects redacted Docker log tails as structured observations", async () => {
    process.env.OPENAI_API_KEY = "secret-value";
    const execFile = vi.fn(async () => ({
      stderr: "",
      stdout: "booted with secret-value\n"
    }));

    const observations = await collectDeploymentLogObservations({
      deployments: [deployment()],
      execFile,
      loadedReport: loadedReport(),
      tail: 5,
      timeoutMs: 42
    });

    expect(execFile).toHaveBeenCalledWith(
      "docker",
      ["--context", "remote", "logs", "--tail", "5", "container-123"],
      { timeout: 42 }
    );
    expect(observations).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({
          container_ref: "container-123",
          log_tail: "booted with [REDACTED]\n"
        }),
        key: "deployment.logs",
        severity: "ok",
        source: "deployment",
        subject: "deployment-unit:default:default-container"
      })
    ]);
  });

  it("normalizes log command failures without throwing", async () => {
    const execFile = vi.fn(async () => {
      throw new Error("docker timeout");
    });

    const observations = await collectDeploymentLogObservations({
      deployments: [deployment()],
      execFile,
      loadedReport: loadedReport()
    });

    expect(observations).toContainEqual(expect.objectContaining({
      key: "deployment.logs",
      severity: "unknown",
      subject: "deployment-unit:default:default-container"
    }));
  });

  it("does not redact env values when no loaded compile report declares them", async () => {
    process.env.OPENAI_API_KEY = "not-declared";
    const execFile = vi.fn(async () => ({
      stderr: "",
      stdout: "not-declared remains normal text\n"
    }));

    const observations = await collectDeploymentLogObservations({
      deployments: [deployment()],
      execFile,
      loadedReport: { kind: "missing", reportPath: "/project/.spawn/spawnfile-report.json" }
    });

    expect(observations[0]?.details?.log_tail).toBe("not-declared remains normal text\n");
  });
});
