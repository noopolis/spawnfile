import { describe, expect, it, vi } from "vitest";

import type { DeploymentRecord } from "./record.js";
import { readDockerDeploymentLogs, redactDockerLogText } from "./dockerLogs.js";

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

describe("docker deployment logs", () => {
  it("collects logs through the recorded Docker context with tail and timeout", async () => {
    const record = createRecord();
    const execFile = vi.fn(async () => ({
      stderr: "stderr line\n",
      stdout: "stdout line\n"
    }));

    const result = await readDockerDeploymentLogs(record, {
      execFile,
      tail: 25,
      timeoutMs: 75
    });

    expect(execFile).toHaveBeenCalledWith(
      "docker",
      ["--context", "remote", "logs", "--tail", "25", "container-123"],
      { timeout: 75 }
    );
    expect(result.get("default-container")).toEqual({
      containerRef: "container-123",
      message: "logs collected",
      severity: "ok",
      text: "stdout line\nstderr line\n",
      unitId: "default-container"
    });
  });

  it("supports host targets and custom docker commands", async () => {
    const record = createRecord();
    record.target = { kind: "host", value: "ssh://ops@example" };
    const execFile = vi.fn(async () => ({ stderr: "", stdout: "" }));

    const result = await readDockerDeploymentLogs(record, {
      dockerCommand: "podman",
      execFile
    });

    expect(execFile).toHaveBeenCalledWith(
      "podman",
      ["--host", "ssh://ops@example", "logs", "--tail", "100", "container-123"],
      { timeout: 10000 }
    );
    expect(result.get("default-container")).toMatchObject({
      message: "logs collected; no output",
      severity: "ok",
      text: ""
    });
  });

  it("redacts supplied secrets and obvious token shapes", async () => {
    const record = createRecord();
    const execFile = vi.fn(async () => ({
      stderr: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456\n",
      stdout: [
        "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
        "agent_token=magt_v1_abcdefghijklmnopqrstuvwxyz123456",
        "{\"refresh_token\":\"super-secret-value\"}"
      ].join("\n")
    }));

    const result = await readDockerDeploymentLogs(record, {
      execFile,
      secretValues: ["super-secret-value"]
    });

    const text = result.get("default-container")?.text ?? "";
    expect(text).not.toContain("super-secret-value");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(text).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(text).toContain("agent_token=[REDACTED]");
    expect(text).toContain("\"refresh_token\":\"[REDACTED]\"");
    expect(text).toContain("Authorization: Bearer [REDACTED]");
  });

  it("returns structured failures instead of throwing", async () => {
    const record = createRecord();
    record.target = { kind: "host", value: "ssh://ops@example" };
    const error = new Error("logs failed") as Error & { stderr: string };
    error.stderr = "Error: No such object: container-123";
    const execFile = vi.fn(async () => {
      throw error;
    });

    const result = await readDockerDeploymentLogs(record, { execFile });

    expect(result.get("default-container")).toEqual({
      containerRef: "container-123",
      message: "recorded container container-123 is missing",
      severity: "warn",
      text: "",
      unitId: "default-container"
    });
  });

  it("does not call Docker for deployment units without a container reference", async () => {
    const record = createRecord();
    record.units[0]!.container_id = null;
    record.units[0]!.container_name = null;
    const execFile = vi.fn(async () => ({ stderr: "", stdout: "" }));

    const result = await readDockerDeploymentLogs(record, { execFile });

    expect(execFile).not.toHaveBeenCalled();
    expect(result.get("default-container")).toEqual({
      containerRef: null,
      message: "deployment unit has no recorded container id or name",
      severity: "unknown",
      text: "",
      unitId: "default-container"
    });
  });
});

describe("redactDockerLogText", () => {
  it("redacts direct secret values without touching unrelated text", () => {
    expect(redactDockerLogText("before token-value after", ["token-value"])).toBe(
      "before [REDACTED] after"
    );
  });
});
