import { chmod, mkdtemp, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseOpaqueTargetHandle } from "./contracts.js";
import { createDockerArtifactSpec } from "./dockerArtifactsProvider.js";
import { createDockerResourceSpec } from "./dockerResourcesProvider.js";
import {
  createWorldServiceAuthorization,
  parseWorldServiceResolution
} from "./dockerWorldServiceAuthority.js";
import { createDockerWorldServiceSpec } from "./dockerWorldServiceProvider.js";
import {
  createWorldServiceBinding,
  createWorldServiceMutationAdmission,
  initializeWorldServiceAuthorityReader,
  initializeWorldServiceAuthorityStore,
  parseWorldServiceBinding,
  worldServiceResourceBindings
} from "./dockerWorldServiceStore.js";

const digest = (value: string): string => `sha256:${value.repeat(64)}`;
const handle = (value: string) => parseOpaqueTargetHandle(`opaque_${value.repeat(16)}`);
const selectedTarget = {
  fingerprint: `sha256:${"f".repeat(32)}`,
  handle: handle("t")
};
const runId = "run-world-store";
const dataClaim = { operationHandle: handle("n"), requestDigest: digest("1") };
const evidenceClaim = { operationHandle: handle("v"), requestDigest: digest("2") };

const fixture = () => {
  const data = createDockerResourceSpec({
    kind: "data_network", ...dataClaim, runId, selectedTargetHandle: selectedTarget.handle
  });
  const evidence = createDockerResourceSpec({
    kind: "evidence_volume", ...evidenceClaim, runId,
    selectedTargetHandle: selectedTarget.handle
  });
  const artifact = createDockerArtifactSpec({
    artifactManifestDigest: digest("a"),
    imageDigest: digest("b"),
    imageReference: `registry.example/world@${digest("b")}`,
    operationHandle: handle("a"),
    requestDigest: digest("3"),
    selectedTargetHandle: selectedTarget.handle
  });
  const authorization = createWorldServiceAuthorization({
    dataNetworkHandle: data.resultHandle,
    descriptorDigest: digest("d"),
    evidenceMountPath: "/run/world/evidence",
    evidenceVolumeHandle: evidence.resultHandle,
    operationHandle: handle("o"),
    requestDigest: digest("4"),
    runId,
    secretBindingsHandle: handle("s"),
    selectedTarget,
    worldArtifactHandle: artifact.resultHandle
  });
  const resolution = parseWorldServiceResolution({
    artifact: {
      artifact_manifest_digest: digest("a"),
      identity_kind: "oci_image_manifest" as const,
      image_digest: artifact.imageDigest,
      image_reference: artifact.imageReference,
      operation_handle: handle("a"),
      request_digest: digest("3"),
      result_handle: artifact.resultHandle
    },
    authorization
  });
  const resources = worldServiceResourceBindings({
    dataNetworkClaim: dataClaim,
    evidenceVolumeClaim: evidenceClaim,
    resolution
  });
  const spec = createDockerWorldServiceSpec({
    dataNetwork: resources.data_network,
    evidenceMountPath: authorization.evidence_mount_path,
    evidenceVolume: resources.evidence_volume,
    imageDigest: resolution.artifact.image_digest,
    imageReference: resolution.artifact.image_reference,
    operationHandle: authorization.operation_handle,
    requestDigest: authorization.request_digest,
    runId,
    secretBindings: resources.secret_bindings,
    selectedTargetHandle: selectedTarget.handle
  });
  const binding = createWorldServiceBinding({
    containerId: "c".repeat(64),
    dataNetwork: resources.data_network,
    evidenceVolume: resources.evidence_volume,
    resolution,
    secretBindings: resources.secret_bindings,
    spec
  });
  return { authorization, binding, resolution, spec };
};

describe("world service authority store", () => {
  it("accepts only operation-specific mutation admissions", () => {
    const { binding, spec } = fixture();
    const common = {
      containerName: spec.containerName,
      operationHandle: handle("z"),
      requestDigest: digest("9"),
      worldServiceHandle: binding.world_service_handle
    };
    for (const value of [
      { ...common, containerId: null, operation: "create_world_service" },
      { ...common, containerId: binding.container_id, operation: "start_world_service" },
      { ...common, containerId: binding.container_id, operation: "stop_world_service" }
    ]) expect(createWorldServiceMutationAdmission(value)).toMatchObject({
      operation: value.operation,
      world_service_handle: binding.world_service_handle
    });
    for (const value of [
      { ...common, containerId: null, operation: "unknown" },
      { ...common, containerId: null, containerName: 7, operation: "create_world_service" },
      { ...common, containerId: null, containerName: "container", operation: "create_world_service" },
      { ...common, containerId: null, operation: "create_world_service", requestDigest: 7 },
      { ...common, containerId: null, operation: "create_world_service", requestDigest: "bad" },
      { ...common, containerId: binding.container_id, operation: "create_world_service" },
      { ...common, containerId: null, operation: "start_world_service" },
      { ...common, containerId: "short", operation: "stop_world_service" }
    ]) expect(() => createWorldServiceMutationAdmission(value)).toThrow(
      "Docker world-service lifecycle failed"
    );
    expect(() => createWorldServiceMutationAdmission({
      ...common, containerId: null, operation: "create_world_service", operationHandle: "bad"
    })).toThrow();
    expect(() => createWorldServiceMutationAdmission({
      ...common, containerId: null, operation: "create_world_service", worldServiceHandle: "bad"
    })).toThrow();
  });

  it("rejects malformed and cross-correlated world-service bindings", () => {
    const { binding, resolution, spec } = fixture();
    const common = {
      containerId: binding.container_id,
      dataNetwork: binding.resources.data_network,
      evidenceVolume: binding.resources.evidence_volume,
      resolution,
      secretBindings: binding.resources.secret_bindings,
      spec
    };
    for (const value of [
      { ...common, containerId: null },
      { ...common, containerId: "short" },
      { ...common, dataNetwork: null },
      { ...common, dataNetwork: { ...binding.resources.data_network, labels: {} } },
      { ...common, dataNetwork: { ...binding.resources.data_network, handle: handle("x") } },
      { ...common, evidenceVolume: { ...binding.resources.evidence_volume, handle: handle("x") } },
      { ...common, secretBindings: { ...binding.resources.secret_bindings, handle: handle("x") } },
      { ...common, spec: { ...spec, containerName: `spfc_${"0".repeat(58)}` } }
    ]) expect(() => createWorldServiceBinding(value as never)).toThrow(
      "Docker world-service lifecycle failed"
    );
  });

  it("rejects malformed binding envelopes and public label maps", () => {
    const { binding } = fixture();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      null,
      [],
      cyclic,
      { ...binding, extra: true },
      { ...binding, version: "wrong" },
      { ...binding, resources: null },
      { ...binding, resources: { ...binding.resources, extra: true } },
      { ...binding, receipt_labels: {} },
      { ...binding, receipt_labels: { "": "value" } },
      { ...binding, receipt_labels: { key: "" } },
      { ...binding, receipt_labels: { key: 7 } },
      { ...binding, container_id: "short" }
    ]) expect(() => parseWorldServiceBinding(value)).toThrow(
      "Docker world-service lifecycle failed"
    );
  });

  it("rejects invalid authority roots before touching the filesystem", async () => {
    for (const root of [null, "", "x".repeat(4_097)]) {
      await expect(initializeWorldServiceAuthorityStore(root)).rejects.toThrow(
        "Docker world-service lifecycle failed"
      );
    }
  });

  it("requires exact resource-producing claims", () => {
    const { resolution } = fixture();
    expect(() => worldServiceResourceBindings({
      dataNetworkClaim: { ...dataClaim, operationHandle: handle("x") },
      evidenceVolumeClaim: evidenceClaim,
      resolution
    })).toThrow("Docker world-service lifecycle failed");
    expect(() => worldServiceResourceBindings({
      dataNetworkClaim: dataClaim,
      evidenceVolumeClaim: { ...evidenceClaim, requestDigest: digest("8") },
      resolution
    })).toThrow("Docker world-service lifecycle failed");
  });

  it("persists exact immutable resolution, binding, and mutation admissions privately", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-world-store-")));
    const store = await initializeWorldServiceAuthorityStore(root);
    const { binding, resolution, spec } = fixture();
    const admission = createWorldServiceMutationAdmission({
      containerId: binding.container_id,
      containerName: spec.containerName,
      operation: "start_world_service",
      operationHandle: handle("z"),
      requestDigest: digest("9"),
      worldServiceHandle: binding.world_service_handle
    });
    await store.bindResolution(resolution);
    await store.bindService(binding);
    await store.bindService(binding);
    await store.bindMutationAdmission(admission);
    await expect(store.bindMutationAdmission({ ...admission, version: "wrong" } as never))
      .rejects.toThrow("Docker world-service lifecycle failed");
    await store.requireMutationAdmission(admission);
    expect(await store.loadService(binding.world_service_handle)).toEqual(binding);
    const reader = await initializeWorldServiceAuthorityReader(root);
    expect(await reader.loadService(binding.world_service_handle)).toEqual(binding);
    expect(Object.keys(reader)).toEqual([]);
    const entries = await readdir(root);
    expect(entries).toHaveLength(3);
    for (const entry of entries) expect((await stat(path.join(root, entry))).mode & 0o077).toBe(0);
  });

  it("rejects absent, altered, and conflicting authority instead of rewriting it", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-world-store-")));
    const store = await initializeWorldServiceAuthorityStore(root);
    const { binding, spec } = fixture();
    const admission = createWorldServiceMutationAdmission({
      containerId: binding.container_id,
      containerName: spec.containerName,
      operation: "stop_world_service",
      operationHandle: handle("y"),
      requestDigest: digest("8"),
      worldServiceHandle: binding.world_service_handle
    });
    await expect(store.requireMutationAdmission(admission)).rejects.toThrow(
      "Docker world-service lifecycle failed"
    );
    await store.bindMutationAdmission(admission);
    await expect(store.requireMutationAdmission({ ...admission,
      request_digest: digest("7") })).rejects.toThrow();
    await store.bindService(binding);
    await expect(store.bindService({ ...binding,
      container_id: "d".repeat(64) })).rejects.toThrow();
  });

  it("revalidates stored bindings and rejects hostile filesystem roots", async () => {
    const { binding } = fixture();
    expect(parseWorldServiceBinding(binding)).toEqual(binding);
    expect(() => parseWorldServiceBinding({ ...binding,
      world_service_handle: handle("x") })).toThrow();
    const parent = await mkdtemp(path.join(os.tmpdir(), "spawnfile-world-link-"));
    const target = await mkdtemp(path.join(os.tmpdir(), "spawnfile-world-target-"));
    const linked = path.join(parent, "authority");
    await symlink(target, linked);
    await expect(initializeWorldServiceAuthorityStore(linked)).rejects.toThrow(
      "Docker world-service lifecycle failed"
    );
  });

  it("fails closed on absent, non-private, and malformed read authorities", async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-world-reader-")));
    const missing = path.join(parent, "missing");
    await expect(initializeWorldServiceAuthorityReader(missing)).rejects.toThrow(
      "Docker world-service lifecycle failed"
    );
    await expect(initializeWorldServiceAuthorityReader("relative/authority"))
      .rejects.toThrow("Docker world-service lifecycle failed");

    const regularFile = path.join(parent, "authority.json");
    await writeFile(regularFile, "{}", { mode: 0o600 });
    await expect(initializeWorldServiceAuthorityReader(regularFile)).rejects.toThrow();

    const publicRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-world-public-")));
    await chmod(publicRoot, 0o755);
    await expect(initializeWorldServiceAuthorityReader(publicRoot)).rejects.toThrow();

    const privateRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-world-private-")));
    const reader = await initializeWorldServiceAuthorityReader(privateRoot);
    await expect(reader.loadService(handle("q"))).rejects.toThrow();
  });

  it("revalidates private record mode and JSON on every reader load", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-world-reader-")));
    const store = await initializeWorldServiceAuthorityStore(root);
    const { binding } = fixture();
    await store.bindService(binding);
    const serviceFile = (await readdir(root)).find((entry) => entry.endsWith(".service.json"))!;
    const servicePath = path.join(root, serviceFile);
    const reader = await initializeWorldServiceAuthorityReader(root);

    await chmod(servicePath, 0o644);
    await expect(reader.loadService(binding.world_service_handle)).rejects.toThrow();
    await chmod(servicePath, 0o600);
    await writeFile(servicePath, "{");
    await expect(reader.loadService(binding.world_service_handle)).rejects.toThrow();
  });
});
