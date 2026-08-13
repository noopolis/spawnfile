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

  it("returns false instead of throwing when docker cp fails", async () => {
    const execFile = vi.fn(async () => {
      throw new Error("no such file");
    });
    await expect(
      copyContainerFileToHost({
        containerPath: "/missing",
        containerRef: "spawnfile-org",
        dockerCommand: "docker",
        execFile,
        hostPath: "/tmp/out/missing",
        target: localTarget,
        timeoutMs: 1_000
      })
    ).resolves.toBe(false);
  });
});

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

  it("returns false when the volume itself cannot be mounted (create fails), without attempting cp", async () => {
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("create")) {
        throw new Error("no such volume");
      }
      return { stderr: "", stdout: "" };
    });

    const result = await copyVolumeFileToHost({
      dockerCommand: "docker",
      execFile,
      hostPath: "/tmp/out/causal.jsonl",
      readerImage: "spawnfile-org:latest",
      target: localTarget,
      timeoutMs: 1_000,
      volumeName: "missing-volume",
      volumePath: "causal.jsonl"
    });

    expect(result).toBe(false);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("still removes the throwaway container when cp fails", async () => {
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("cp")) {
        throw new Error("no such file in volume");
      }
      return { stderr: "", stdout: "" };
    });

    const result = await copyVolumeFileToHost({
      dockerCommand: "docker",
      execFile,
      hostPath: "/tmp/out/missing.jsonl",
      readerImage: "spawnfile-org:latest",
      target: localTarget,
      timeoutMs: 1_000,
      volumeName: "vol",
      volumePath: "missing.jsonl"
    });

    expect(result).toBe(false);
    const calledCommands = execFile.mock.calls.map(([, args]: [string, string[]]) =>
      args.find((arg) => ["create", "cp", "rm"].includes(arg))
    );
    expect(calledCommands).toEqual(["create", "cp", "rm"]);
  });
});
