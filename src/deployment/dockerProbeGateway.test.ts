import { describe, expect, it, vi } from "vitest";

import type { DeploymentRecord, DockerUnitInspection } from "./index.js";
import { createDockerProbeGateway } from "./dockerProbeGateway.js";

const createRecord = (): DeploymentRecord => ({
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

const inspection: DockerUnitInspection = {
  containerId: "container-123",
  drift: [],
  exists: true,
  exitCode: 0,
  finishedAt: null,
  identity: null,
  imageId: "image-123",
  message: "running",
  restartCount: 0,
  running: true,
  severity: "ok",
  startedAt: "2026-06-11T00:00:00.000Z",
  status: "running",
  unitId: "default-container"
};

describe("docker probe gateway", () => {
  it("runs commands inside the recorded Docker context and unit", async () => {
    const record = createRecord();
    const execFile = vi.fn(async () => ({ stderr: "", stdout: "ok\n" }));
    const gateway = createDockerProbeGateway(record, record.units[0]!, {
      execFile,
      inspection,
      timeoutMs: 50
    });

    await expect(gateway.exec(["test", "-d", "/workspace"])).resolves.toEqual({
      stderr: "",
      stdout: "ok\n"
    });
    expect(execFile).toHaveBeenCalledWith(
      "docker",
      ["--context", "remote", "exec", "container-123", "test", "-d", "/workspace"],
      { timeout: 50 }
    );
  });

  it("performs HTTP probes through a same-image network helper and parses status", async () => {
    const record = createRecord();
    record.target = { kind: "host", value: "ssh://ops@example" };
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stderr: "", stdout: "{\"ok\":true}\n200" })
      .mockRejectedValueOnce(new Error("curl failed"));
    const gateway = createDockerProbeGateway(record, record.units[0]!, {
      dockerCommand: "podman",
      execFile,
      inspection
    });

    await expect(gateway.httpGet(18789, "healthz")).resolves.toEqual({
      body: "{\"ok\":true}",
      ok: true
    });
    await expect(gateway.httpGet(18789, "/ready")).resolves.toEqual({
      body: "",
      error: "curl failed",
      ok: false
    });
    expect(execFile).toHaveBeenNthCalledWith(
      1,
      "podman",
      ["--host", "ssh://ops@example", "run", "--rm", "--network", "container:container-123", "--entrypoint", "curl", "image-123", "-sS", "--output", "-", "--write-out", "\\n%{http_code}", "http://127.0.0.1:18789/healthz"],
      { timeout: 10000 }
    );
  });

  it("returns the supplied unit inspection", async () => {
    const record = createRecord();
    const gateway = createDockerProbeGateway(record, record.units[0]!, {
      execFile: async () => ({ stderr: "", stdout: "" }),
      inspection
    });

    await expect(gateway.inspectUnit()).resolves.toBe(inspection);
  });

  it("falls back to container name and normalizes non-Error HTTP failures", async () => {
    const record = createRecord();
    record.target = { kind: "docker-context", context: "legacy", endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef" };
    record.units[0]!.container_id = null;
    const execFile = vi.fn(async () => {
      throw "curl exploded";
    });
    const gateway = createDockerProbeGateway(record, record.units[0]!, {
      execFile,
      inspection
    });

    await expect(gateway.httpGet(18789, "/healthz")).resolves.toEqual({
      body: "",
      error: "curl exploded",
      ok: false
    });
    expect(execFile).toHaveBeenCalledWith(
      "docker",
      ["--context", "legacy", "run", "--rm", "--network", "container:project", "--entrypoint", "curl", "image-123", "-sS", "--output", "-", "--write-out", "\\n%{http_code}", "http://127.0.0.1:18789/healthz"],
      { timeout: 10000 }
    );
  });

  it("handles non-success and malformed HTTP output and rejects headers", async () => {
    const record = createRecord();
    const execFile = vi.fn()
      .mockResolvedValueOnce({ stderr: "", stdout: "unauthorized\n401" })
      .mockResolvedValueOnce({ stderr: "", stdout: "malformed" });
    const gateway = createDockerProbeGateway(record, record.units[0]!, { execFile, inspection });
    await expect(gateway.httpGet(8787, "/healthz")).resolves.toEqual({ body: "unauthorized", error: "HTTP 401", ok: false });
    await expect(gateway.httpGet(8787, "/healthz")).resolves.toEqual({ body: "", error: "malformed HTTP probe response", ok: false });
    await expect(gateway.httpGet(8787, "/healthz", { Authorization: "Bearer secret" })).resolves.toEqual({ body: "", error: "HTTP probe headers are forbidden", ok: false });
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("normalizes bare image digests and reports bounded, redacted startup failures", async () => {
    const record = createRecord();
    record.units[0]!.image_id = "a".repeat(64);
    const execFile = vi.fn(async () => {
      throw Object.assign(new Error("Command failed"), {
        code: 125,
        stderr: "pull denied Authorization: Bearer super-secret-token"
      });
    });
    const gateway = createDockerProbeGateway(record, record.units[0]!, { execFile, inspection });

    await expect(gateway.httpGet(19971, "/healthz")).resolves.toEqual({
      body: "",
      error: "docker probe exit 125: pull denied Authorization=[redacted]",
      ok: false
    });
    expect(execFile).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["sha256:" + "a".repeat(64)]),
      { timeout: 10000 }
    );
    expect(JSON.stringify(execFile.mock.calls)).not.toContain("super-secret-token");
  });

  it("rejects deployment units without a recorded container reference", async () => {
    const record = createRecord();
    record.units[0]!.container_id = null;
    record.units[0]!.container_name = null;
    const gateway = createDockerProbeGateway(record, record.units[0]!, {
      execFile: async () => ({ stderr: "", stdout: "" }),
      inspection
    });

    await expect(gateway.exec(["true"])).rejects.toThrow(
      "deployment unit default-container has no recorded container id or name"
    );
  });
});
