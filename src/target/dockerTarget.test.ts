import { describe, expect, it } from "vitest";

import {
  createEndpointFingerprint,
  selectTarget,
  type DockerTargetExecFile
} from "./dockerTarget.js";
import { parseOpaqueTargetHandle, parseSelectedTargetReceipt } from "./contracts.js";

const context = "production";
const endpoint = "ssh://deploy@example.com";

const executor = (stdout = JSON.stringify(endpoint)): DockerTargetExecFile => async () => ({ stderr: "", stdout });

describe("selectTarget", () => {
  it("inspects exactly one named context and returns a strict secret-free receipt", async () => {
    const calls: Array<[string, string[], { signal?: AbortSignal; timeout: number }]> = [];
    const receipt = await selectTarget({
      context,
      execFile: async (file, args, options) => {
        calls.push([file, args, options]);
        return { stderr: "", stdout: JSON.stringify(endpoint) };
      },
      timeoutMs: 4321
    });

    expect(calls).toEqual([["docker", ["context", "inspect", context, "--format", "{{json .Endpoints.docker.Host}}"], { signal: undefined, timeout: 4321 }]]);
    expect(receipt).toEqual({
      fingerprint: createEndpointFingerprint(endpoint),
      handle: expect.stringMatching(/^opaque_[a-z0-9]{64}$/),
      version: "spawnfile.target-resource.selected-target.v1"
    });
    expect(parseSelectedTargetReceipt(receipt)).toEqual(receipt);
    expect(parseOpaqueTargetHandle(receipt.handle)).toBe(receipt.handle);
    expect(JSON.stringify(receipt)).not.toContain(context);
    expect(JSON.stringify(receipt)).not.toContain(endpoint);
  });

  it("accepts JSON and plain endpoint output with deterministic, domain-separated handles", async () => {
    const json = await selectTarget({ context, execFile: executor() });
    const plain = await selectTarget({ context, execFile: executor(`${endpoint}\n`) });
    const otherContext = await selectTarget({ context: "staging", execFile: executor() });
    const otherEndpoint = await selectTarget({ context, execFile: executor(JSON.stringify("ssh://other@example.com")) });

    expect(json).toEqual(plain);
    expect(json.handle).not.toBe(otherContext.handle);
    expect(json.handle).not.toBe(otherEndpoint.handle);
  });

  it("rejects ambient and raw-host selection modes without executing Docker", async () => {
    const original = process.env.DOCKER_HOST;
    process.env.DOCKER_HOST = "ssh://ambient@example.com";
    try {
      const calls: unknown[] = [];
      const noCall: DockerTargetExecFile = async (...args) => {
        calls.push(args);
        return { stderr: "", stdout: JSON.stringify(endpoint) };
      };
      await expect(selectTarget({ context, dockerHost: "ssh://raw@example.com", execFile: noCall })).rejects.toMatchObject({ code: "runtime_error", message: "Target selection failed" });
      await expect(selectTarget({ context, DOCKER_HOST: "ssh://raw@example.com", execFile: noCall })).rejects.toMatchObject({ code: "runtime_error", message: "Target selection failed" });
      await expect(selectTarget({ context, endpoint, execFile: noCall })).rejects.toMatchObject({ code: "runtime_error", message: "Target selection failed" });
      await expect(selectTarget({ context, host: "ssh://raw@example.com", execFile: noCall })).rejects.toMatchObject({ code: "runtime_error", message: "Target selection failed" });
      expect(calls).toEqual([]);
      await expect(selectTarget({ context, execFile: noCall })).resolves.toMatchObject({
        fingerprint: createEndpointFingerprint(endpoint)
      });
      expect(calls).toHaveLength(1);
    } finally {
      if (original === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = original;
    }
  });

  it("rejects absent, hostile, malformed, empty, and failed inspection without leaking private data", async () => {
    const privateContext = "secret_context";
    const privateEndpoint = "ssh://secret:token@example.com";
    const failures = [
      selectTarget({ execFile: executor() }),
      selectTarget({ context: "DEFAULT", execFile: executor() }),
      selectTarget({ context: "x".repeat(65), execFile: executor() }),
      selectTarget({ context: privateContext, execFile: executor("   ") }),
      selectTarget({ context: privateContext, execFile: executor("{}") }),
      selectTarget({ context: privateContext, execFile: async () => { throw new Error(privateEndpoint); } })
    ];
    for (const failure of failures) {
      await expect(failure).rejects.toMatchObject({ code: "runtime_error", message: "Target selection failed" });
      await failure.catch((error: unknown) => {
        expect(String(error)).not.toContain(privateContext);
        expect(String(error)).not.toContain(privateEndpoint);
      });
    }
  });

  it("rejects oversized raw JSON and plain output before endpoint processing", async () => {
    const oversizedJson = `${" ".repeat(4_096)}${JSON.stringify(endpoint)}`;
    const oversizedPlain = `${"\t".repeat(4_096)}${endpoint}`;

    for (const stdout of [oversizedJson, oversizedPlain]) {
      await expect(selectTarget({ context, execFile: executor(stdout) })).rejects.toMatchObject({
        code: "runtime_error",
        message: "Target selection failed"
      });
    }
  });

  it("bounds executor stdout by UTF-8 bytes at the exact boundary", async () => {
    const atBoundary = `${endpoint}${" ".repeat(4_096 - Buffer.byteLength(endpoint, "utf8"))}`;
    const overBoundary = `${atBoundary}é`;

    await expect(selectTarget({ context, execFile: executor(atBoundary) })).resolves.toMatchObject({
      fingerprint: createEndpointFingerprint(endpoint)
    });
    await expect(selectTarget({ context, execFile: executor(overBoundary) })).rejects.toMatchObject({
      code: "runtime_error",
      message: "Target selection failed"
    });
  });
});
