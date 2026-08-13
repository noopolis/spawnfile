import { describe, expect, it } from "vitest";

import { createDockerArtifactSpec } from "./dockerArtifactsProvider.js";
import type { DockerTargetExecutors } from "./dockerCommandExecutor.js";
import { createDockerResourceSpec } from "./dockerResourcesProvider.js";
import { createExistingDockerSecretSpec } from "./dockerSecretsProvider.js";
import { createDockerWorldClockReader, TARGET_WORLD_CLOCK_ERROR } from "./dockerWorldClock.js";
import { createWorldServiceAuthorization } from "./dockerWorldServiceAuthority.js";
import { worldServiceSpecForBinding } from "./dockerWorldServiceLifecycle.js";
import type { DockerWorldServiceExecutor, DockerWorldServiceSpec } from "./dockerWorldServiceProvider.js";
import { createWorldServiceBinding, type WorldServiceAuthorityReader } from "./dockerWorldServiceStore.js";
import {
  createCanonicalWorldServiceActivationBytes,
  createTargetTopologyActivationReceiptDigest,
  createWorldServiceActivationDigest,
  parseWorldServiceActivation,
} from "./topologyActivation.js";
import { parseOpaqueTargetHandle } from "./contracts.js";
import { parseTargetWorldClockRequest } from "./worldClock.js";

const h = (value: string) => parseOpaqueTargetHandle(`opaque_${value.repeat(64).slice(0, 64)}`);
const d = (value: string): `sha256:${string}` => `sha256:${value.repeat(64).slice(0, 64)}`;
const containerId = "c".repeat(64);
const binding = () => {
  const selected = h("1");
  const network = createDockerResourceSpec({ kind: "data_network", operationHandle: h("2"), requestDigest: d("2"), runId: "run-clock", selectedTargetHandle: selected });
  const evidence = createDockerResourceSpec({ kind: "evidence_volume", operationHandle: h("3"), requestDigest: d("3"), runId: "run-clock", selectedTargetHandle: selected });
  const secrets = createExistingDockerSecretSpec({ bindingsHandle: h("4"), runId: "run-clock", selectedTargetHandle: selected });
  const artifact = createDockerArtifactSpec({ artifactManifestDigest: d("5"), imageDigest: d("6"), imageReference: `registry/world@${d("6")}`, operationHandle: h("7"), requestDigest: d("7"), selectedTargetHandle: selected });
  const authorization = createWorldServiceAuthorization({
    dataNetworkHandle: network.resultHandle, descriptorDigest: d("8"), evidenceMountPath: "/run/world/evidence",
    evidenceVolumeHandle: evidence.resultHandle, operationHandle: h("9"), requestDigest: d("9"), runId: "run-clock",
    secretBindingsHandle: secrets.resultHandle, selectedTarget: { fingerprint: `sha256:${"a".repeat(32)}`, handle: selected },
    worldArtifactHandle: artifact.resultHandle,
  });
  const resolution = Object.freeze({ artifact: Object.freeze({
    artifact_manifest_digest: d("5"), identity_kind: "oci_image_manifest" as const,
    image_digest: d("6"), image_reference: `registry/world@${d("6")}`,
    operation_handle: h("7"), request_digest: d("7"), result_handle: artifact.resultHandle,
  }), authorization });
  const resources = Object.freeze({
    data_network: Object.freeze({ handle: network.resultHandle, labels: network.labels, name: network.name }),
    evidence_volume: Object.freeze({ handle: evidence.resultHandle, labels: evidence.labels, name: evidence.name }),
    secret_bindings: Object.freeze({ handle: secrets.resultHandle, labels: secrets.labels, name: secrets.volumeName }),
  });
  const spec = worldServiceSpecForBinding({ resolution, resources });
  return createWorldServiceBinding({ containerId, dataNetwork: resources.data_network, evidenceVolume: resources.evidence_volume, resolution, secretBindings: resources.secret_bindings, spec });
};
const after = (args: readonly string[], flag: string): string => args[args.indexOf(flag) + 1]!;
const inspection = (spec: DockerWorldServiceSpec): Record<string, unknown> => ({
  AutoRemove: false, BindCount: 0, CapAddCount: 0, CapDrop: ["ALL"], CgroupnsMode: "private", DeviceCount: 0,
  DeviceRequestCount: 0, DnsCount: 0, Domainname: "", ExposedPortCount: 0, ExtraHostCount: 0, GroupAddCount: 0,
  Hostname: spec.containerName, Id: containerId, Image: spec.imageReference, IpcMode: "none", Labels: spec.receiptLabels,
  LinkCount: 0, LogType: "none", Mounts: spec.createArgs.filter((value, index, values) => values[index - 1] === "--mount")
    .map((value) => Object.fromEntries(value.split(",").map((part) => part.split("=", 2))))
    .map((mount) => ({ Destination: mount.dst, Name: mount.src, RW: mount.dst === spec.evidenceMountPath, Type: "volume" })),
  Name: `/${spec.containerName}`, NetworkAliases: spec.networkAlias ? [spec.networkAlias] : null,
  NetworkAttachmentCount: 1, NetworkAttachmentId: "b".repeat(64), NetworkAttachmentName: after(spec.createArgs, "--network"),
  NetworkMode: after(spec.createArgs, "--network"), PidMode: "", PortBindingCount: 0, Privileged: false,
  PublishAllPorts: false, ReadonlyRootfs: true, RestartMaximumRetryCount: 0, RestartPolicyName: "no",
  SecurityOpt: ["no-new-privileges=true"], Status: "running", Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=1m,mode=1777" },
  UTSMode: "", UsernsMode: "", VolumesFromCount: 0,
});
const marker = parseWorldServiceActivation({
  bundle_digest: d("5"), run_id: "run-clock", state: "activated",
  topology_receipt_digest: d("c"), topology_request_digest: d("d"),
  version: "spawnfile.world-service-activation.v1",
});
const activationDigest = createWorldServiceActivationDigest(marker);
const activationReceiptDigest = createTargetTopologyActivationReceiptDigest({
  activation_digest: activationDigest, bundle_digest: marker.bundle_digest,
  receipt_digest: d("0"), run_id: marker.run_id, state: "activated",
  topology_receipt_digest: marker.topology_receipt_digest,
  topology_request_digest: marker.topology_request_digest,
  version: "spawnfile.target-topology-activation-receipt.v1",
});
const request = (world = binding()) => parseTargetWorldClockRequest({
  activation_digest: activationDigest, activation_receipt_digest: activationReceiptDigest,
  descriptor_digest: world.resolution.authorization.descriptor_digest,
  endpoint: { internal_port: 4_070, path: "/v1/world/clock" },
  expected: { document_version: "world.clock-document.v1", world_instance_id: "world-clock" },
  run_id: "run-clock", selected_target: world.resolution.authorization.selected_target,
  topology_receipt_digest: d("c"), topology_request_digest: d("d"),
  version: "spawnfile.target-world-clock.request.v1", world_service_handle: world.world_service_handle,
});
const observation = { action_count: 0, clock: { completed_tick: 1, next_tick: 2, state: "running" },
  run_id: "run-clock", version: "world.clock-document.v1", world_instance_id: "world-clock" };

describe("Docker world-clock adapter", () => {
  const harness = (observed: unknown = observation) => {
    const world = binding(); const spec = worldServiceSpecForBinding(world); const calls: string[][] = [];
    const executor: DockerWorldServiceExecutor = async (_file, args) => ({ stderr: "", stdout: JSON.stringify([inspection(spec)]) });
    const contentExecutor: DockerTargetExecutors["publicArtifact"] = async (_file, args) => {
      calls.push([...args]);
      return { bytes: args.includes("/bin/cat") ? Buffer.from(createCanonicalWorldServiceActivationBytes(marker)) : Buffer.from(JSON.stringify(observed)) };
    };
    const authority: WorldServiceAuthorityReader = { loadService: async () => world };
    return { calls, reader: createDockerWorldClockReader({ authorityStore: authority, context: "gpu-4090", contentExecutor, executor, timeoutMs: 30_000 }), world };
  };

  it("reads immutable activation authority and one exact localhost clock", async () => {
    const value = harness(); const receipt = await value.reader.query(request(value.world));
    expect(receipt.clock).toEqual(observation.clock); expect(receipt.action_count).toBe(0);
    expect(value.calls).toHaveLength(2); expect(value.calls[0]!.at(-1)).toContain("world-service-activated.v1");
    expect(value.calls[1]!.at(-1)).toBe("/v1/world/clock");
    expect(value.calls[1]!.join(" ")).toContain("127.0.0.1");
  });

  it("fails closed for no tick, action, stale authority, or activation mismatch", async () => {
    for (const observed of [
      { ...observation, clock: { completed_tick: 0, next_tick: 1, state: "running" } },
      { ...observation, action_count: 1 },
      { ...observation, run_id: "run-stale" },
    ]) await expect(harness(observed).reader.query(request())).rejects.toThrow(TARGET_WORLD_CLOCK_ERROR);
    const changed = harness();
    await expect(changed.reader.query({ ...request(changed.world), activation_digest: d("f") }))
      .rejects.toThrow(TARGET_WORLD_CLOCK_ERROR);
    expect(changed.calls).toHaveLength(1);
  });
});
