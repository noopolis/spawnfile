import { describe, expect, it, vi } from "vitest";

import type { DeploymentRecord } from "./record.js";
import {
  containerExists,
  copyContainerFileToHost,
  copyVolumeFileToHost
} from "./artifactsExportDocker.js";

const localTarget: DeploymentRecord["target"] = {
  endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef",
  kind: "context",
  name: "default"
};

const contextTarget: DeploymentRecord["target"] = {
  endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef",
  kind: "context",
  name: "hetzner"
};

describe("containerExists", () => {
  it("returns true when docker inspect succeeds", async () => {
    const execFile = vi.fn(async () => ({ stderr: "", stdout: "[]" }));
    await expect(
      containerExists(localTarget, "spawnfile-org", { dockerCommand: "docker", execFile, timeoutMs: 1_000 })
    ).resolves.toBe(true);
    expect(execFile).toHaveBeenCalledWith(
      "docker",
      ["--context", "default", "inspect", "--type", "container", "spawnfile-org"],
      { timeout: 1_000 }
    );
  });

  it("returns false when docker reports the container missing", async () => {
    const execFile = vi.fn(async () => {
      throw { stderr: "Error: No such container: spawnfile-org" };
    });
    await expect(
      containerExists(localTarget, "spawnfile-org", { dockerCommand: "docker", execFile, timeoutMs: 1_000 })
    ).resolves.toBe(false);
  });

  it("re-throws an unrelated docker failure instead of reporting it as missing", async () => {
    const execFile = vi.fn(async () => {
      throw { stderr: "Cannot connect to the Docker daemon" };
    });
    await expect(
      containerExists(localTarget, "spawnfile-org", { dockerCommand: "docker", execFile, timeoutMs: 1_000 })
    ).rejects.toThrow(/Cannot connect to the Docker daemon/);
  });

  it("prefixes a remote context onto every docker call", async () => {
    const execFile = vi.fn(async () => ({ stderr: "", stdout: "[]" }));
    await containerExists(contextTarget, "spawnfile-org", { dockerCommand: "docker", execFile, timeoutMs: 1_000 });
    expect(execFile).toHaveBeenCalledWith(
      "docker",
      ["--context", "hetzner", "inspect", "--type", "container", "spawnfile-org"],
      { timeout: 1_000 }
    );
  });
});

const containerCopy = {
  containerPath: "/missing",
  containerRef: "spawnfile-org",
  dockerCommand: "docker",
  hostPath: "/tmp/out/missing",
  target: localTarget,
  timeoutMs: 1_000
};

describe("copyContainerFileToHost", () => {
  it("runs docker cp and returns true on success", async () => {
    const execFile = vi.fn(async () => ({ stderr: "", stdout: "" }));
    await expect(
      copyContainerFileToHost({
        containerPath: "/runtime/agents/eleanor/telemetry/causal.jsonl",
        containerRef: "spawnfile-org",
        dockerCommand: "docker",
        execFile,
        hostPath: "/tmp/out/causal.jsonl",
        target: localTarget,
        timeoutMs: 1_000
      })
    ).resolves.toBe(true);
    expect(execFile).toHaveBeenCalledWith(
      "docker",
      ["--context", "default", "cp", "spawnfile-org:/runtime/agents/eleanor/telemetry/causal.jsonl", "/tmp/out/causal.jsonl"],
      { timeout: 1_000 }
    );
  });

  it("returns false only when docker names this source absent and the container is confirmed available", async () => {
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("cp")) throw { stderr: "Error: No such container:path: spawnfile-org:/missing" };
      return { stderr: "", stdout: "[]" };
    });
    await expect(copyContainerFileToHost({ ...containerCopy, execFile })).resolves.toBe(false);
    expect(execFile.mock.calls.map(([, args]) => args[2])).toEqual(["cp", "inspect"]);
  });

  it("accepts the older daemon wording for an absent source", async () => {
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("cp")) throw { stderr: "Error response from daemon: Could not find the file /missing in container spawnfile-org" };
      return { stderr: "", stdout: "[]" };
    });
    await expect(copyContainerFileToHost({ ...containerCopy, execFile })).resolves.toBe(false);
  });

  it("throws when the absent-path diagnostic comes from a container that no longer exists", async () => {
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("cp")) throw { stderr: "Error: No such container:path: spawnfile-org:/missing" };
      throw { stderr: "Error: No such object: spawnfile-org" };
    });
    await expect(copyContainerFileToHost({ ...containerCopy, execFile })).rejects.toThrow(/container "spawnfile-org" is not available/);
  });

  it("throws when the container availability check itself fails", async () => {
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("cp")) throw { stderr: "Error: No such container:path: spawnfile-org:/missing" };
      throw { stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" };
    });
    await expect(copyContainerFileToHost({ ...containerCopy, execFile })).rejects.toThrow(/Unable to confirm .*Cannot connect/);
  });

  it.each([
    ["daemon unavailable", { stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" }],
    ["local disk full", { stderr: "Error: open /tmp/out/missing: no space left on device" }],
    ["local permission denied", { stderr: "Error: open /tmp/out/missing: permission denied" }],
    ["a different source", { stderr: "Error: No such container:path: spawnfile-org:/other" }],
    ["timeout kill", Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", stderr: "Error: No such container:path: spawnfile-org:/missing" })],
    ["plain error without diagnostics", new Error("no such file")]
  ])("throws instead of reporting an optional miss on %s", async (_label, failure) => {
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("cp")) throw failure;
      return { stderr: "", stdout: "[]" };
    });
    await expect(copyContainerFileToHost({ ...containerCopy, execFile })).rejects.toThrow(/Unable to copy "spawnfile-org:\/missing"/);
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});

const volumeCopy = {
  dockerCommand: "docker",
  hostPath: "/tmp/out/missing.jsonl",
  readerImage: "spawnfile-org:latest",
  target: localTarget,
  timeoutMs: 1_000,
  volumeName: "vol",
  volumePath: "missing.jsonl"
};

describe("copyVolumeFileToHost", () => {
  it("creates a throwaway reader container, copies the file out, and always removes it", async () => {
    const calls: string[][] = [];
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      calls.push(args);
      return { stderr: "", stdout: "" };
    });

    const result = await copyVolumeFileToHost({
      dockerCommand: "docker",
      execFile,
      hostPath: "/tmp/out/causal.jsonl",
      readerImage: "spawnfile-org:latest",
      target: localTarget,
      timeoutMs: 1_000,
      volumeName: "spawnfile-project-moltnet-causal-abc123",
      volumePath: "causal.jsonl"
    });

    expect(result).toBe(true);
    expect(calls).toHaveLength(3);
    // Every call carries the recorded deployment target's "--context default" prefix
    // (withDockerTarget), same as every other deployment Docker helper in this folder.
    expect(calls[0].slice(0, 2)).toEqual(["--context", "default"]);
    expect(calls[0].slice(2)).toEqual(
      expect.arrayContaining(["create", "-v", "spawnfile-project-moltnet-causal-abc123:/spawnfile-export-src:ro", "spawnfile-org:latest"])
    );
    expect(calls[1].slice(0, 2)).toEqual(["--context", "default"]);
    expect(calls[1][2]).toBe("cp");
    expect(calls[1][3]).toMatch(/^spawnfile-artifacts-export-.+:\/spawnfile-export-src\/causal\.jsonl$/);
    expect(calls[1][4]).toBe("/tmp/out/causal.jsonl");
    const readerContainerName = calls[0][calls[0].indexOf("--name") + 1];
    expect(calls[2]).toEqual(["--context", "default", "rm", "-f", readerContainerName]);
  });

  it.each([
    ["reader image missing", { stderr: "Unable to find image 'spawnfile-org:latest' locally" }],
    ["volume create failure", { stderr: "Error response from daemon: create missing-volume: error while creating volume" }],
    ["daemon unavailable", { stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" }],
    ["timeout kill", Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" })]
  ])("throws when the reader cannot be created (%s), without attempting cp", async (_label, failure) => {
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("create")) throw failure;
      return { stderr: "", stdout: "" };
    });

    await expect(copyVolumeFileToHost({ ...volumeCopy, execFile })).rejects.toThrow(/Unable to create a reader for volume "vol"/);
    const calledCommands = execFile.mock.calls.map(([, args]: [string, string[]]) =>
      args.find((arg) => ["create", "cp", "rm"].includes(arg))
    );
    expect(calledCommands).toEqual(["create", "rm"]);
  });

  it("returns false for a confirmed absent volume file and still removes the reader", async () => {
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("cp")) {
        const source = args[args.indexOf("cp") + 1]!;
        throw { stderr: `Error: No such container:path: ${source}` };
      }
      return { stderr: "", stdout: "" };
    });

    await expect(copyVolumeFileToHost({ ...volumeCopy, execFile })).resolves.toBe(false);
    const calledCommands = execFile.mock.calls.map(([, args]: [string, string[]]) =>
      args.find((arg) => ["create", "cp", "inspect", "rm"].includes(arg))
    );
    expect(calledCommands).toEqual(["create", "cp", "inspect", "rm"]);
  });

  it("throws on a non-absence cp failure and still removes the reader", async () => {
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("cp")) throw { stderr: "Error: open /tmp/out/missing.jsonl: no space left on device" };
      return { stderr: "", stdout: "" };
    });

    await expect(copyVolumeFileToHost({ ...volumeCopy, execFile })).rejects.toThrow(/no space left on device/);
    const calledCommands = execFile.mock.calls.map(([, args]: [string, string[]]) =>
      args.find((arg) => ["create", "cp", "inspect", "rm"].includes(arg))
    );
    expect(calledCommands).toEqual(["create", "cp", "rm"]);
  });
});
