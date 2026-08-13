import { describe, expect, it, vi } from "vitest";

import { parseOpaqueTargetHandle } from "./contracts.js";
import {
  DOCKER_ARTIFACT_ERROR, DOCKER_ARTIFACT_INSPECTION_FORMAT, createDockerArtifactSpec,
  executeDockerArtifact, isExpectedDockerArtifact, isImmutableDockerImageReference,
  parseDockerArtifactMappings
} from "./dockerArtifactsProvider.js";

const manifest = `sha256:${"a".repeat(64)}`;
const imageDigest = `sha256:${"b".repeat(64)}`;
const reference = `registry.example:5000/sim/world@${imageDigest}`;
const mapping = () => ({ artifact_manifest_digest: manifest, image_digest: imageDigest, image_reference: reference });
const spec = createDockerArtifactSpec({
  artifactManifestDigest: manifest, imageDigest, imageReference: reference,
  operationHandle: parseOpaqueTargetHandle(`opaque_${"c".repeat(64)}`), requestDigest: `sha256:${"d".repeat(64)}`,
  selectedTargetHandle: parseOpaqueTargetHandle(`opaque_${"e".repeat(64)}`)
});
const inspection = (repoDigests: unknown = [reference], changes: Record<string, unknown> = {}): string =>
  JSON.stringify([{ RepoDigests: repoDigests, ...changes }]);

describe("Docker artifact provider boundary", () => {
  it("admits only an exact one-to-one B100 digest to immutable OCI mapping", () => {
    expect(parseDockerArtifactMappings([mapping()])).toEqual([mapping()]);
    for (const hostile of [
      [], [{ ...mapping(), extra: "x" }], [{ ...mapping(), image_reference: "registry.example/sim/world:latest" }],
      [{ ...mapping(), image_reference: `registry.example/sim/world:latest@${imageDigest}` }],
      [{ ...mapping(), artifact_manifest_digest: `${manifest}\n` }],
      [{ ...mapping(), image_reference: `${reference}\n` }],
      [{ ...mapping(), image_reference: `bad_host.example/sim/world@${imageDigest}` }],
      [{ ...mapping(), image_reference: `registry.example:65536/sim/world@${imageDigest}` }],
      [{ ...mapping(), source_path: "/tmp/world" }], [mapping(), mapping()],
      [{ ...mapping(), image_digest: `sha256:${"c".repeat(64)}` }]
    ]) expect(() => parseDockerArtifactMappings(hostile)).toThrow(DOCKER_ARTIFACT_ERROR);
    const aliased = mapping(); expect(() => parseDockerArtifactMappings([aliased, aliased])).toThrow(DOCKER_ARTIFACT_ERROR);
    expect(() => parseDockerArtifactMappings([new Proxy(mapping(), {})])).toThrow(DOCKER_ARTIFACT_ERROR);
    expect(() => parseDockerArtifactMappings([{ ...mapping(), get image_reference(): string { throw new Error("secret"); } }]))
      .toThrow(DOCKER_ARTIFACT_ERROR);
  });

  it("derives a deterministic opaque result and identifier-only private correlation labels", () => {
    expect(spec).toEqual(createDockerArtifactSpec({
      artifactManifestDigest: manifest, imageDigest, imageReference: reference,
      operationHandle: parseOpaqueTargetHandle(`opaque_${"c".repeat(64)}`), requestDigest: `sha256:${"d".repeat(64)}`,
      selectedTargetHandle: parseOpaqueTargetHandle(`opaque_${"e".repeat(64)}`)
    }));
    expect(spec.inspectionFormat).toBe(DOCKER_ARTIFACT_INSPECTION_FORMAT);
    expect(spec.resultHandle).toMatch(/^opaque_[a-f0-9]{64}$/u);
    for (const [key, value] of Object.entries(spec.labels)) {
      expect(key).toMatch(/^[a-z][a-z0-9_]{0,63}$/u); expect(value).toMatch(/^[a-z][a-z0-9_]{0,63}$/u);
    }
    expect(JSON.stringify({ labels: spec.labels, result: spec.resultHandle })).not.toContain(reference);
  });

  it("accepts only one exact projected immutable digest set", () => {
    expect(isExpectedDockerArtifact(inspection(), spec)).toBe(true);
    expect(isExpectedDockerArtifact(inspection([`mirror.example/sim/world@${imageDigest}`, reference]), spec)).toBe(true);
    for (const hostile of [
      inspection([]), inspection([`registry.example/sim/world@sha256:${"f".repeat(64)}`]),
      inspection([reference, reference]), inspection(["registry.example/sim/world:latest"]),
      inspection([`${reference}\n`]), inspection([`registry.example:65536/sim/world@${imageDigest}`]),
      inspection([reference], { Id: `sha256:${"1".repeat(64)}` }), JSON.stringify([]),
      JSON.stringify([{ RepoDigests: [reference], "": [] }]),
      JSON.stringify([{ RepoDigests: [reference] }, { RepoDigests: [reference] }]),
      `[{"RepoDigests":["${reference}"],"RepoDigests":[]}]`, "[not-json]", "x".repeat(32_769),
      JSON.stringify([{ RepoDigests: ["\ud800"] }])
    ]) expect(isExpectedDockerArtifact(hostile, spec)).toBe(false);
  });

  it("enforces Docker's canonical repository-name byte boundary", () => {
    expect(parseDockerArtifactMappings([{ ...mapping(), image_reference: `${"a".repeat(255)}@${imageDigest}` }]))
      .toHaveLength(1);
    expect(() => parseDockerArtifactMappings([{ ...mapping(), image_reference: `${"a".repeat(256)}@${imageDigest}` }]))
      .toThrow(DOCKER_ARTIFACT_ERROR);
  });

  it("enforces registry, repository, port, separator, and digest grammar independently", () => {
    expect(isImmutableDockerImageReference(`library/world@${imageDigest}`)).toBe(true);
    expect(isImmutableDockerImageReference(`localhost/world@${imageDigest}`)).toBe(true);
    expect(isImmutableDockerImageReference(`registry.example:1/world@${imageDigest}`)).toBe(true);
    for (const hostile of [
      null,
      `registry.example/world@${imageDigest}`.toUpperCase(),
      `registry.example/world:${imageDigest}`,
      `registry.example/world@${imageDigest}@${imageDigest}`,
      `${"a".repeat(256)}@${imageDigest}`,
      `a:b:c/world@${imageDigest}`,
      `registry.example:0/world@${imageDigest}`,
      `-registry.example/world@${imageDigest}`,
      `registry.example//world@${imageDigest}`,
      `registry.example/world-/nested@${imageDigest}`,
      `registry.example/world@sha256:${"A".repeat(64)}`,
    ]) expect(isImmutableDockerImageReference(hostile)).toBe(false);
  });

  it("rejects non-array, oversized, non-record, and independently duplicated mappings", () => {
    for (const hostile of [
      null,
      {},
      Array.from({ length: 33 }, mapping),
      [null],
      [[]],
      [1],
      [{ ...mapping(), artifact_manifest_digest: null }],
      [{ ...mapping(), image_digest: null }],
      [{ ...mapping(), image_reference: null }],
      [mapping(), { ...mapping(), image_digest: `sha256:${"c".repeat(64)}`,
        image_reference: `registry.example/other@sha256:${"c".repeat(64)}` }],
      [mapping(), { ...mapping(), artifact_manifest_digest: `sha256:${"c".repeat(64)}` }],
      [mapping(), { ...mapping(), artifact_manifest_digest: `sha256:${"c".repeat(64)}`,
        image_digest: `sha256:${"d".repeat(64)}` }],
    ]) expect(() => parseDockerArtifactMappings(hostile)).toThrow(DOCKER_ARTIFACT_ERROR);
  });

  it("uses only fixed docker and bounds all executor output and failures", async () => {
    const executor = vi.fn(async () => ({ stderr: "", stdout: inspection() }));
    await expect(executeDockerArtifact({ args: ["image", "inspect"], executor, timeoutMs: 10 })).resolves.toMatchObject({ stdout: inspection() });
    expect(executor).toHaveBeenCalledWith("docker", ["image", "inspect"], { signal: undefined, timeout: 10 });
    await expect(executeDockerArtifact({ args: [], executor: async () => { throw new Error("secret://token"); }, timeoutMs: 1 }))
      .rejects.toThrow(DOCKER_ARTIFACT_ERROR);
    await expect(executeDockerArtifact({ args: [], executor: async () => ({ stderr: "x".repeat(32_769), stdout: "" }), timeoutMs: 1 }))
      .rejects.toThrow(DOCKER_ARTIFACT_ERROR);
    await expect(executeDockerArtifact({ args: [], executor: async () => ({ stderr: "", stdout: "\ud800" }), timeoutMs: 1 }))
      .rejects.toThrow(DOCKER_ARTIFACT_ERROR);
  });
});
