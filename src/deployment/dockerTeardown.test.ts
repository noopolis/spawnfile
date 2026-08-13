import { describe, expect, it, vi } from "vitest";

import type { DeploymentRecord } from "./record.js";
import { removeDockerContainer, removeDockerVolume, type DockerTeardownExecFile } from "./dockerTeardown.js";

const contextTarget: DeploymentRecord["target"] = {
  endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef",
  kind: "context",
  name: "prod"
};

const hostTarget: DeploymentRecord["target"] = { kind: "host", value: "ssh://deploy@example.com" };

const runnerOptions = { dockerCommand: "docker", timeoutMs: 5_000 };

describe("removeDockerContainer", () => {
  it("force-removes a container and reports it removed", async () => {
    const execFile: DockerTeardownExecFile = vi.fn(async () => ({ stderr: "", stdout: "" }));
    const outcome = await removeDockerContainer(contextTarget, "container-123", {
      ...runnerOptions,
      execFile
    });

    expect(outcome).toEqual({ error: null, removed: true });
    expect(execFile).toHaveBeenCalledWith(
      "docker",
      ["--context", "prod", "rm", "-f", "container-123"],
      { timeout: 5_000 }
    );
  });

  it("prefixes --host args for a host target", async () => {
    const execFile: DockerTeardownExecFile = vi.fn(async () => ({ stderr: "", stdout: "" }));
    await removeDockerContainer(hostTarget, "container-123", { ...runnerOptions, execFile });

    expect(execFile).toHaveBeenCalledWith(
      "docker",
      ["--host", "ssh://deploy@example.com", "rm", "-f", "container-123"],
      { timeout: 5_000 }
    );
  });

  it("treats an already-gone container as removed (idempotent down)", async () => {
    const execFile: DockerTeardownExecFile = vi.fn(async () => {
      throw { stderr: "Error: No such container: container-123" };
    });
    const outcome = await removeDockerContainer(contextTarget, "container-123", {
      ...runnerOptions,
      execFile
    });

    expect(outcome).toEqual({ error: null, removed: true });
  });

  it("surfaces a genuine Docker failure instead of masking it as success", async () => {
    const execFile: DockerTeardownExecFile = vi.fn(async () => {
      throw { stderr: "Error: cannot connect to the Docker daemon" };
    });
    const outcome = await removeDockerContainer(contextTarget, "container-123", {
      ...runnerOptions,
      execFile
    });

    expect(outcome.removed).toBe(false);
    expect(outcome.error).toMatch(/cannot connect to the Docker daemon/);
  });
});

describe("removeDockerVolume", () => {
  it("force-removes a named volume and reports it removed", async () => {
    const execFile: DockerTeardownExecFile = vi.fn(async () => ({ stderr: "", stdout: "" }));
    const outcome = await removeDockerVolume(contextTarget, "spawnfile-project-memory-abc123", {
      ...runnerOptions,
      execFile
    });

    expect(outcome).toEqual({ error: null, removed: true });
    expect(execFile).toHaveBeenCalledWith(
      "docker",
      ["--context", "prod", "volume", "rm", "-f", "spawnfile-project-memory-abc123"],
      { timeout: 5_000 }
    );
  });

  it("treats an already-gone volume as removed", async () => {
    const execFile: DockerTeardownExecFile = vi.fn(async () => {
      throw { stderr: "Error: No such volume: spawnfile-project-memory-abc123" };
    });
    const outcome = await removeDockerVolume(contextTarget, "spawnfile-project-memory-abc123", {
      ...runnerOptions,
      execFile
    });

    expect(outcome).toEqual({ error: null, removed: true });
  });

  it("surfaces a genuine Docker failure", async () => {
    const execFile: DockerTeardownExecFile = vi.fn(async () => {
      throw new Error("in use by container abc");
    });
    const outcome = await removeDockerVolume(contextTarget, "spawnfile-project-memory-abc123", {
      ...runnerOptions,
      execFile
    });

    expect(outcome.removed).toBe(false);
    expect(outcome.error).toMatch(/in use by container abc/);
  });
});
