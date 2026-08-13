import { describe, expect, it, vi } from "vitest";

import type { DeploymentRecord } from "./record.js";
import { inspectDockerDeployment } from "./dockerInspect.js";
import { dockerDeploymentLabelKeys } from "./dockerLabels.js";

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

const liveIdentityLabels = (): Record<string, string> => ({
  [dockerDeploymentLabelKeys.compileFingerprint]: "sf1:abc123",
  [dockerDeploymentLabelKeys.deployment]: "default",
  [dockerDeploymentLabelKeys.project]: "project-alpha",
  [dockerDeploymentLabelKeys.runId]: "run-abc123",
  [dockerDeploymentLabelKeys.unit]: "default-container",
  [dockerDeploymentLabelKeys.version]: "spawnfile.v0.1"
});

const inspectOutput = (labels: unknown): string => JSON.stringify([{
  Config: { Labels: labels },
  Id: "container-123",
  Image: "image-123",
  State: { Running: true, Status: "running" }
}]);

const inspectWithLabels = async (labels: unknown) => {
  const record = createRecord();
  record.target = { kind: "host", value: "ssh://ops@example" };
  return inspectDockerDeployment(record, {
    execFile: async () => ({ stderr: "", stdout: inspectOutput(labels) })
  });
};

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
            Config: { Labels: liveIdentityLabels() },
            Id: "container-123",
            Image: "image-123",
            RestartCount: 1,
            State: {
              ExitCode: 0,
              FinishedAt: "",
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
      identity: {
        compileFingerprint: "sf1:abc123",
        deployment: "default",
        project: "project-alpha",
        runId: "run-abc123",
        unit: "default-container",
        version: "spawnfile.v0.1"
      },
      message: "container is running (running)",
      restartCount: 1,
      running: true,
      severity: "ok",
      status: "running"
    });
  });

  it("reads restart count from the top-level Docker inspection payload", async () => {
    const record = createRecord();
    record.target = { kind: "host", value: "ssh://ops@example" };
    const result = await inspectDockerDeployment(record, {
      execFile: async () => ({
        stderr: "",
        stdout: JSON.stringify([{
          Id: "container-123",
          RestartCount: 0,
          State: { Running: true, Status: "running" }
        }])
      })
    });

    expect(result.get("default-container")?.restartCount).toBe(0);
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

  it("projects only the complete canonical compiler-owned label identity", async () => {
    const labels = {
      ...liveIdentityLabels(),
      "com.spawnfile.project_alias": "wrong-project",
      "com.example.path": "/private/project",
      "com.example.secret": "sentinel-secret-value",
      "com.example.url": "https://secret.example/token"
    };
    const result = await inspectWithLabels(labels);
    const inspection = result.get("default-container");

    expect(inspection?.identity).toEqual({
      compileFingerprint: "sf1:abc123",
      deployment: "default",
      project: "project-alpha",
      runId: "run-abc123",
      unit: "default-container",
      version: "spawnfile.v0.1"
    });
    expect(JSON.stringify(inspection)).not.toMatch(
      /sentinel-secret-value|secret\.example|\/private\/project|wrong-project/
    );
  });

  it("rejects every missing or malformed canonical identity label without exposing it", async () => {
    const canonical = liveIdentityLabels();
    for (const key of Object.values(dockerDeploymentLabelKeys)) {
      const missing = { ...canonical };
      delete missing[key];
      expect((await inspectWithLabels(missing)).get("default-container")?.identity).toBeNull();
    }

    for (const key of Object.values(dockerDeploymentLabelKeys)) {
      for (const value of ["", " ", "/unsafe/path", "has space", "line\nbreak", "x".repeat(129), 7]) {
        const hostile = { ...canonical, [key]: value };
        const inspection = (await inspectWithLabels(hostile)).get("default-container");
        expect(inspection?.identity).toBeNull();
        if (typeof value === "string" && value.length > 0 && value !== " ") {
          expect(JSON.stringify(inspection)).not.toContain(value);
        }
      }
    }
  });

  it("rejects malformed label shapes and lookalike keys without throwing", async () => {
    const lookalike = liveIdentityLabels();
    delete lookalike[dockerDeploymentLabelKeys.runId];
    lookalike["com.spawnfile.run-id"] = "run-abc123";
    for (const labels of [null, [], "labels", lookalike]) {
      await expect(inspectWithLabels(labels)).resolves.toEqual(expect.any(Map));
      expect((await inspectWithLabels(labels)).get("default-container")?.identity).toBeNull();
    }

    const record = createRecord();
    record.target = { kind: "host", value: "ssh://ops@example" };
    for (const config of [null, [], "config", { Labels: null }, { Labels: [] }]) {
      const result = await inspectDockerDeployment(record, {
        execFile: async () => ({
          stderr: "",
          stdout: JSON.stringify([{ Config: config, State: { Running: true, Status: "running" } }])
        })
      });
      expect(result.get("default-container")?.identity).toBeNull();
    }
  });

  it("keeps identity null outside complete live inspections", async () => {
    const record = createRecord();
    record.target = { kind: "host", value: "ssh://ops@example" };
    const missing = await inspectDockerDeployment(record, {
      execFile: async () => { throw new Error("No such object"); }
    });
    const stopped = await inspectDockerDeployment(record, {
      execFile: async () => ({ stderr: "", stdout: JSON.stringify([{ State: { Running: false } }]) })
    });
    const malformed = await inspectDockerDeployment(record, {
      execFile: async () => ({ stderr: "", stdout: "[]" })
    });
    const targetFailure = await inspectDockerDeployment(createRecord(), {
      execFile: async () => ({ stderr: "", stdout: "\"ssh://other@example\"" })
    });

    for (const result of [missing, stopped, malformed, targetFailure]) {
      expect(result.get("default-container")?.identity).toBeNull();
    }
  });
});
