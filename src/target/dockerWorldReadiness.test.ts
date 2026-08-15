import { describe, expect, it } from "vitest";

import { parseOpaqueTargetHandle } from "./contracts.js";
import { createDockerArtifactSpec } from "./dockerArtifactsProvider.js";
import type { DockerTargetExecutors } from "./dockerCommandExecutor.js";
import { createDockerResourceSpec } from "./dockerResourcesProvider.js";
import { createExistingDockerSecretSpec } from "./dockerSecretsProvider.js";
import { createWorldServiceAuthorization } from "./dockerWorldServiceAuthority.js";
import { createDockerWorldReadinessReader } from "./dockerWorldReadiness.js";
import { worldServiceSpecForBinding } from "./dockerWorldServiceLifecycle.js";
import type {
  DockerWorldServiceExecutor,
  DockerWorldServiceSpec
} from "./dockerWorldServiceProvider.js";
import {
  createWorldServiceBinding,
  type WorldServiceAuthorityStore,
  type WorldServiceBinding
} from "./dockerWorldServiceStore.js";
import { parseTargetWorldReadinessRequest } from "./worldReadiness.js";

const h = (value: string) =>
  parseOpaqueTargetHandle(`opaque_${value.repeat(64).slice(0, 64)}`);
const d = (value: string): `sha256:${string}` =>
  `sha256:${value.repeat(64).slice(0, 64)}`;
const containerId = "c".repeat(64);

const fixtureBinding = (): WorldServiceBinding => {
  const selectedTargetHandle = h("1");
  const network = createDockerResourceSpec({
    kind: "data_network", operationHandle: h("2"), requestDigest: d("2"),
    runId: "run-ready", selectedTargetHandle
  });
  const evidence = createDockerResourceSpec({
    kind: "evidence_volume", operationHandle: h("3"), requestDigest: d("3"),
    runId: "run-ready", selectedTargetHandle
  });
  const secrets = createExistingDockerSecretSpec({
    bindingsHandle: h("4"), runId: "run-ready", selectedTargetHandle
  });
  const artifact = createDockerArtifactSpec({
    artifactManifestDigest: d("5"), imageDigest: d("6"),
    imageReference: `registry.example/world@${d("6")}`,
    operationHandle: h("7"), requestDigest: d("7"), selectedTargetHandle
  });
  const authorization = createWorldServiceAuthorization({
    dataNetworkHandle: network.resultHandle, descriptorDigest: d("8"),
    evidenceMountPath: "/run/world/evidence",
    evidenceVolumeHandle: evidence.resultHandle, operationHandle: h("9"),
    requestDigest: d("9"), runId: "run-ready",
    secretBindingsHandle: secrets.resultHandle,
    selectedTarget: {
      fingerprint: `sha256:${"a".repeat(32)}`,
      handle: selectedTargetHandle
    },
    worldArtifactHandle: artifact.resultHandle
  });
  const resolution = Object.freeze({
    artifact: Object.freeze({
      artifact_manifest_digest: d("5"), identity_kind: "oci_image_manifest" as const,
      image_digest: d("6"), image_reference: `registry.example/world@${d("6")}`,
      operation_handle: h("7"), request_digest: d("7"),
      result_handle: artifact.resultHandle
    }),
    authorization
  });
  const resources = Object.freeze({
    data_network: Object.freeze({
      handle: network.resultHandle, labels: network.labels, name: network.name
    }),
    evidence_volume: Object.freeze({
      handle: evidence.resultHandle, labels: evidence.labels, name: evidence.name
    }),
    secret_bindings: Object.freeze({
      handle: secrets.resultHandle, labels: secrets.labels, name: secrets.volumeName
    })
  });
  const spec = worldServiceSpecForBinding({ resolution, resources });
  return createWorldServiceBinding({
    containerId,
    dataNetwork: resources.data_network,
    evidenceVolume: resources.evidence_volume,
    resolution,
    secretBindings: resources.secret_bindings,
    spec
  });
};

const after = (args: readonly string[], flag: string): string =>
  args[args.indexOf(flag) + 1]!;
const inspection = (spec: DockerWorldServiceSpec): Record<string, unknown> => ({
  AutoRemove: false, BindCount: 0, CapAddCount: 0, CapDrop: ["ALL"],
  CgroupnsMode: "private", DeviceCount: 0, DeviceRequestCount: 0, DnsCount: 0,
  Domainname: "", ExposedPortCount: 0, ExtraHostCount: 0, GroupAddCount: 0,
  Hostname: spec.containerName, Id: containerId, Image: spec.imageReference,
  IpcMode: "none", Labels: spec.receiptLabels, LinkCount: 0, LogType: "none",
  Mounts: spec.createArgs.filter((value, index, values) =>
    values[index - 1] === "--mount").map((value) =>
    Object.fromEntries(value.split(",").map((part) => part.split("=", 2))))
    .map((mount) => ({
      Destination: mount.dst, Name: mount.src,
      RW: mount.dst === spec.evidenceMountPath, Type: "volume"
    })),
  Name: `/${spec.containerName}`,
  NetworkAliases: spec.networkAlias ? [spec.networkAlias] : null,
  NetworkAttachmentCount: 1, NetworkAttachmentId: "b".repeat(64),
  NetworkAttachmentName: after(spec.createArgs, "--network"),
  NetworkMode: after(spec.createArgs, "--network"),
  PidMode: "", PortBindingCount: 0, Privileged: false, PublishAllPorts: false,
  ReadonlyRootfs: true, RestartMaximumRetryCount: 0, RestartPolicyName: "no",
  SecurityOpt: ["no-new-privileges=true"], Status: "running",
  Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=1m,mode=1777" },
  UTSMode: "", UsernsMode: "", VolumesFromCount: 0
});

const requestFor = (binding: WorldServiceBinding) =>
  parseTargetWorldReadinessRequest({
    descriptor_digest: binding.resolution.authorization.descriptor_digest,
    endpoint: { internal_port: 4_071, path: "/v1/world/readiness" },
    expected: {
      artifact_digest: d("5"), bundle_digest: d("d"),
      capability_manifest_digests: [d("e")],
      document_version: "example.world-readiness.v1",
      mechanics_sha256: d("f"), normalized_checkpoint_sha256: d("0"),
      runtime_abi: "example.world-runtime.v1",
      world_instance_id: "run-ready-world"
    },
    run_id: binding.resolution.authorization.run_id,
    selected_target: binding.resolution.authorization.selected_target,
    version: "spawnfile.target-world-readiness.request.v1",
    world_service_handle: binding.world_service_handle
  });
const document = {
  artifact_digest: d("5"), bundle_digest: d("d"),
  capability_manifest_digests: [d("e")],
  clock: { next_tick: 0, state: "paused" },
  decisions: { count: 0, phase: "open" }, mechanics_sha256: d("f"),
  normalized_checkpoint_sha256: d("0"), run_id: "run-ready",
  runtime_abi: "example.world-runtime.v1", status: "ready",
  version: "example.world-readiness.v1", world_instance_id: "run-ready-world"
} as const;
const authority = (binding: WorldServiceBinding): WorldServiceAuthorityStore => ({
  bindMutationAdmission: async () => undefined,
  bindResolution: async () => undefined,
  bindService: async () => undefined,
  loadService: async () => binding,
  requireMutationAdmission: async () => undefined
});

describe("Docker world-only readiness adapter", () => {
  it("queries only localhost in one exact running world and verifies the response", async () => {
    const binding = fixtureBinding();
    const spec = worldServiceSpecForBinding(binding);
    const inspectCalls: string[][] = [];
    const executor: DockerWorldServiceExecutor = async (_file, args) => {
      inspectCalls.push(args);
      if (args[3] === "inspect") {
        return { stderr: "", stdout: JSON.stringify([inspection(spec)]) };
      }
      throw new Error("unexpected provider command");
    };
    const queryCalls: string[][] = [];
    const contentExecutor: DockerTargetExecutors["publicArtifact"] =
      async (_file, args) => {
        queryCalls.push([...args]);
        return { bytes: Buffer.from(JSON.stringify(document)) };
      };
    const receipt = await createDockerWorldReadinessReader({
      authorityStore: authority(binding), context: "gpu-host", contentExecutor,
      executor, timeoutMs: 30_000
    }).query(requestFor(binding));
    expect(receipt.readiness).toEqual(document);
    expect(inspectCalls.filter((args) => args[3] === "inspect")).toHaveLength(2);
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]!.slice(0, 8)).toEqual([
      "--context", "gpu-host", "container", "exec", containerId,
      "/usr/local/bin/node", "--input-type=module", "-e"
    ]);
    expect(queryCalls[0]!.slice(-2)).toEqual(["4071", "/v1/world/readiness"]);
    const script = queryCalls[0]![8]!;
    expect(script).toContain("127.0.0.1");
    expect(script).not.toContain("organization");
    expect(script).not.toContain("moltnet");
  });

  it("rejects stale authority correlation before Docker or endpoint access", async () => {
    const binding = fixtureBinding();
    const noDocker: DockerWorldServiceExecutor = async () => {
      throw new Error("Docker must not be reached");
    };
    const noQuery: DockerTargetExecutors["publicArtifact"] = async () => {
      throw new Error("endpoint must not be reached");
    };
    await expect(createDockerWorldReadinessReader({
      authorityStore: authority(binding), context: "gpu-host",
      contentExecutor: noQuery, executor: noDocker, timeoutMs: 30_000
    }).query({ ...requestFor(binding), run_id: "run-stale" }))
      .rejects.toThrow("Target world readiness query failed");
    for (const extra of [
      { organizationResolver: { resolve: async () => undefined } },
      { moltnetClient: { read: async () => undefined } },
      { teamRegistry: { load: async () => undefined } }
    ]) expect(() => createDockerWorldReadinessReader({
      authorityStore: authority(binding), context: "gpu-host",
      contentExecutor: noQuery, executor: noDocker, timeoutMs: 30_000,
      ...extra
    } as never)).toThrow("Target world readiness query failed");
  });

  it("rejects forged endpoint documents after exact world inspection", async () => {
    const binding = fixtureBinding();
    const spec = worldServiceSpecForBinding(binding);
    const executor: DockerWorldServiceExecutor = async (_file, args) => ({
      stderr: "",
      stdout: args[3] === "inspect" ? JSON.stringify([inspection(spec)]) : ""
    });
    const forged: DockerTargetExecutors["publicArtifact"] = async () => ({
      bytes: Buffer.from(JSON.stringify({ ...document, run_id: "run-stale" }))
    });
    await expect(createDockerWorldReadinessReader({
      authorityStore: authority(binding), context: "gpu-host",
      contentExecutor: forged, executor, timeoutMs: 30_000
    }).query(requestFor(binding))).rejects.toThrow("Target world readiness query failed");
  });
});
