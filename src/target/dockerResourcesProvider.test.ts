import { describe, expect, it } from "vitest";

import { parseOpaqueTargetHandle } from "./contracts.js";
import { DockerResourceProviderError, createDockerResourceSpec, executeDockerResource, isExpectedDockerResource } from "./dockerResourcesProvider.js";

const spec = createDockerResourceSpec({ kind: "data_network", operationHandle: parseOpaqueTargetHandle(`opaque_${"a".repeat(64)}`), requestDigest: `sha256:${"b".repeat(64)}`, runId: "run-one", selectedTargetHandle: parseOpaqueTargetHandle(`opaque_${"c".repeat(64)}`) });
const inspection = (changes: Record<string, unknown> = {}): string => JSON.stringify([{ Internal: true, Labels: spec.labels, Name: spec.name, ...changes }]);
const volume = createDockerResourceSpec({ kind: "evidence_volume", operationHandle: parseOpaqueTargetHandle(`opaque_${"d".repeat(64)}`), requestDigest: `sha256:${"e".repeat(64)}`, runId: "run-one", selectedTargetHandle: parseOpaqueTargetHandle(`opaque_${"f".repeat(64)}`) });
const volumeInspection = (changes: Record<string, unknown> = {}): string => JSON.stringify([{ Labels: volume.labels, Name: volume.name, ...changes }]);

describe("Docker resource provider boundary", () => {
  it("requires an exact single inspected resource with complete labels and internal networking", () => {
    expect(isExpectedDockerResource(inspection(), spec)).toBe(true);
    for (const hostile of [
      inspection({ Name: "other" }), inspection({ Internal: false }), JSON.stringify([]), JSON.stringify([JSON.parse(inspection())[0], JSON.parse(inspection())[0]]),
      inspection({ Id: "raw-provider-id" }), inspection({ Driver: "bridge" }), inspection({ Labels: { ...spec.labels, unexpected: "value" } }), inspection({ Labels: { ...spec.labels, spawnfile_resource_v1_run: "wrong" } }),
      `[{"Name":"${spec.name}","Internal":true,"Labels":{"spawnfile_resource_v1_kind":"data_network","spawnfile_resource_v1_kind":"wrong"}}]`, "[not-json]", "x".repeat(32_769)
    ]) expect(isExpectedDockerResource(hostile, spec)).toBe(false);
    expect(isExpectedDockerResource(volumeInspection(), volume)).toBe(true);
    expect(isExpectedDockerResource(inspection(), volume)).toBe(false);
    expect(isExpectedDockerResource(JSON.stringify([{ Labels: spec.labels, Name: spec.name }]), spec)).toBe(false);
    expect(isExpectedDockerResource(volumeInspection({ Internal: true }), volume)).toBe(false);
  });

  it("bounds malformed output and turns errors, aborts, and timeout-like throws into one secret-free failure", async () => {
    const secret = "secret://token@host"; const failing = async (): Promise<{ stderr: string; stdout: string }> => { throw new Error(secret); };
    await expect(executeDockerResource({ args: [], executor: failing, timeoutMs: 1 })).rejects.toThrow("Docker resource mutation failed");
    await expect(executeDockerResource({ args: [], executor: async () => ({ stderr: "", stdout: "\ud800" }), timeoutMs: 1 })).rejects.toThrow("Docker resource mutation failed");
    await expect(executeDockerResource({ args: [], executor: async () => ({ stderr: "x".repeat(32_769), stdout: "" }), timeoutMs: 1 })).rejects.toThrow("Docker resource mutation failed");
    await expect(executeDockerResource({ args: [], executor: async () => { throw new DockerResourceProviderError("not_found"); }, timeoutMs: 1 })).rejects.toMatchObject({ kind: "not_found" });
  });
});
