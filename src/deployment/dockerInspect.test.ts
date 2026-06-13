import { describe, expect, it, vi } from "vitest";

import type { DeploymentRecord } from "./record.js";
import { inspectDockerDeployment } from "./dockerInspect.js";

const createRecord = (): DeploymentRecord => ({
  auth_profile: null,
  compile_fingerprint: "sf1:abc",
  created_at: "2026-06-11T00:00:00.000Z",
  manager: "docker",
  name: "default",
  output_directory: "/project/.spawn",
  source: { kind: "project", root: "/project" },
  target: {
    name: "hetzner",
    endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef",
    kind: "context"
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

describe("docker deployment inspection", () => {
  it("inspects recorded containers through the recorded docker context", async () => {
    const record = createRecord();
    record.target = {
      endpoint_fingerprint: "sha256:e86b65e346836167915e2f99413f2db7",
      kind: "context",
      name: "hetzner"
    };
    const execFile = vi.fn(async (_file: string, args: string[]) => ({
      stderr: "",
      stdout: args.includes("context")
        ? "\"ssh://deploy@example.com\"\n"
        : JSON.stringify([
          {
            Id: "container-123",
            Image: "image-123",
            State: {
              ExitCode: 0,
              FinishedAt: "",
              RestartCount: 1,
              Running: true,
              StartedAt: "2026-06-11T00:00:00.000Z",
              Status: "running"
            }
          }
        ])
    }));

    const result = await inspectDockerDeployment(record, { execFile });

    expect(execFile).toHaveBeenNthCalledWith(
      1,
      "docker",
      ["context", "inspect", "hetzner", "--format", "{{json .Endpoints.docker.Host}}"],
      { timeout: 10000 }
    );
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      "docker",
      ["--context", "hetzner", "inspect", "container-123"],
      { timeout: 10000 }
    );
    expect(result.get("default-container")).toMatchObject({
      exists: true,
      message: "container is running (running)",
      running: true,
      severity: "ok",
      status: "running"
    });
  });

  it("returns missing and unknown observations instead of throwing", async () => {
    const record = createRecord();
    record.target = { kind: "host", value: "ssh://ops@example" };
    const missingExec = vi.fn(async () => {
      const error = new Error("inspect failed") as Error & { stderr: string };
      error.stderr = "Error: No such object: container-123";
      throw error;
    });
    const missing = await inspectDockerDeployment(record, { execFile: missingExec });

    expect(missing.get("default-container")).toMatchObject({
      exists: false,
      running: false,
      severity: "warn"
    });

    const malformedExec = vi.fn(async () => ({ stderr: "", stdout: "[]" }));
    const unknown = await inspectDockerDeployment(record, { execFile: malformedExec });

    expect(unknown.get("default-container")).toMatchObject({
      exists: null,
      running: null,
      severity: "unknown"
    });
  });

  it("does not invoke docker when a unit has no container reference", async () => {
    const record = createRecord();
    record.target = { kind: "host", value: "ssh://ops@example" };
    record.units[0]!.container_id = null;
    record.units[0]!.container_name = null;
    const execFile = vi.fn(async () => ({ stderr: "", stdout: "[]" }));

    const result = await inspectDockerDeployment(record, { execFile });

    expect(execFile).not.toHaveBeenCalled();
    expect(result.get("default-container")).toMatchObject({
      exists: null,
      message: "deployment unit has no recorded container id or name",
      running: null
    });
  });

  it("supports host-like targets and generic inspect failures", async () => {
    const record = createRecord();
    record.target = { kind: "host", value: "ssh://ops@example" };
    const execFile = vi.fn(async () => {
      throw new Error("docker unavailable");
    });

    const result = await inspectDockerDeployment(record as unknown as DeploymentRecord, {
      dockerCommand: "podman",
      execFile,
      timeoutMs: 25
    });

    expect(execFile).toHaveBeenCalledWith("podman", ["--host", "ssh://ops@example", "inspect", "container-123"], { timeout: 25 });
    expect(result.get("default-container")).toMatchObject({
      exists: null,
      message: "unable to inspect container container-123: docker unavailable",
      running: null,
      severity: "error"
    });
  });

  it("formats stopped containers with unknown status when Docker omits status", async () => {
    const record = createRecord();
    record.target = { kind: "host", value: "ssh://ops@example" };
    const execFile = vi.fn(async () => ({
      stderr: "",
      stdout: JSON.stringify([
        {
          State: {
            Running: false
          }
        }
      ])
    }));

    const result = await inspectDockerDeployment(record, { execFile });

    expect(result.get("default-container")).toMatchObject({
      exists: true,
      message: "container is not running (unknown)",
      running: false,
      severity: "error",
      status: null
    });
  });

  it("reports target drift and image/container id drift", async () => {
    const targetDriftRecord = createRecord();
    const targetDrift = await inspectDockerDeployment(targetDriftRecord, {
      execFile: async () => ({ stderr: "", stdout: "\"ssh://other@example\"\n" })
    });

    expect(targetDrift.get("default-container")).toMatchObject({
      exists: null,
      message: expect.stringContaining("unable to verify recorded Docker target"),
      severity: "error"
    });

    const record = createRecord();
    record.target = { kind: "host", value: "ssh://ops@example" };
    const idDrift = await inspectDockerDeployment(record, {
      execFile: async () => ({
        stderr: "",
        stdout: JSON.stringify([
          {
            Id: "other-container",
            Image: "other-image",
            State: {
              Running: true,
              Status: "running"
            }
          }
        ])
      })
    });

    expect(idDrift.get("default-container")).toMatchObject({
      drift: [
        "container id drift: recorded container-123, live other-container",
        "image id drift: recorded image-123, live other-image"
      ],
      severity: "warn"
    });
  });
});
