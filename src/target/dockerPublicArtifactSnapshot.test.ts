import { describe, expect, it } from "vitest";

import { parseOpaqueTargetHandle } from "./contracts.js";
import { createDockerArtifactSpec } from "./dockerArtifactsProvider.js";
import type { DockerTargetExecutors } from "./dockerCommandExecutor.js";
import { createDockerResourceSpec } from "./dockerResourcesProvider.js";
import { createExistingDockerSecretSpec } from "./dockerSecretsProvider.js";
import { createWorldServiceAuthorization } from "./dockerWorldServiceAuthority.js";
import {
  createDockerPublicArtifactSnapshotReader
} from "./dockerPublicArtifactSnapshot.js";
import {
  worldServiceSpecForBinding
} from "./dockerWorldServiceLifecycle.js";
import {
  type DockerWorldServiceExecutor,
  type DockerWorldServiceSpec
} from "./dockerWorldServiceProvider.js";
import {
  createWorldServiceBinding,
  type WorldServiceAuthorityStore,
  type WorldServiceBinding
} from "./dockerWorldServiceStore.js";
import {
  parseTargetPublicArtifactSnapshotRequest
} from "./publicArtifactSnapshot.js";

const h = (value: string) =>
  parseOpaqueTargetHandle(`opaque_${value.repeat(64).slice(0, 64)}`);
const d = (value: string): `sha256:${string}` =>
  `sha256:${value.repeat(64).slice(0, 64)}`;
const containerId = "c".repeat(64);

const fixtureBinding = (): WorldServiceBinding => {
  const selectedTargetHandle = h("1");
  const network = createDockerResourceSpec({
    kind: "data_network", operationHandle: h("2"), requestDigest: d("2"),
    runId: "run-public", selectedTargetHandle
  });
  const evidence = createDockerResourceSpec({
    kind: "evidence_volume", operationHandle: h("3"), requestDigest: d("3"),
    runId: "run-public", selectedTargetHandle
  });
  const secrets = createExistingDockerSecretSpec({
    bindingsHandle: h("4"), runId: "run-public", selectedTargetHandle
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
    requestDigest: d("9"), runId: "run-public",
    secretBindingsHandle: secrets.resultHandle,
    selectedTarget: {
      fingerprint: `sha256:${"a".repeat(32)}`,
      handle: selectedTargetHandle
    },
    worldArtifactHandle: artifact.resultHandle
  });
  const resolution = Object.freeze({
    artifact: Object.freeze({
      artifact_manifest_digest: d("5"),
      identity_kind: "oci_image_manifest" as const,
      image_digest: d("6"),
      image_reference: `registry.example/world@${d("6")}`,
      operation_handle: h("7"),
      request_digest: d("7"),
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
  Mounts: spec.createArgs
    .filter((value, index, values) => values[index - 1] === "--mount")
    .map((value) => Object.fromEntries(value.split(",").map((part) =>
      part.split("=", 2))))
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
  parseTargetPublicArtifactSnapshotRequest({
    artifact: {
      id: "viewer_trace",
      max_bytes: 4_096,
      media_type: "application/json",
      path: "/tmp/spawnfile-public/viewer-trace.json"
    },
    descriptor_digest: binding.resolution.authorization.descriptor_digest,
    run_id: binding.resolution.authorization.run_id,
    selected_target: binding.resolution.authorization.selected_target,
    version: "spawnfile.target-public-artifact-snapshot.request.v1",
    world_service_handle: binding.world_service_handle
  });

const authority = (binding: WorldServiceBinding): WorldServiceAuthorityStore => ({
  bindMutationAdmission: async () => undefined,
  bindResolution: async () => undefined,
  bindService: async () => undefined,
  loadService: async () => binding,
  requireMutationAdmission: async () => undefined
});

describe("Docker public artifact snapshot adapter", () => {
  it("reads only the declared path from one exact running world", async () => {
    const binding = fixtureBinding();
    const spec = worldServiceSpecForBinding(binding);
    const calls: string[][] = [];
    const contentCalls: string[][] = [];
    const executor: DockerWorldServiceExecutor = async (_file, args) => {
      calls.push(args);
      if (args[2] === "container" && args[3] === "inspect") {
        return { stderr: "", stdout: JSON.stringify([inspection(spec)]) };
      }
      throw new Error("unexpected provider command");
    };
    const contentExecutor: DockerTargetExecutors["publicArtifact"] =
      async (_file, args) => {
        contentCalls.push([...args]);
        return { bytes: Uint8Array.from(Buffer.from(
          args[5] === "/usr/bin/readlink"
            ? "/tmp/spawnfile-public/viewer-trace.json\n"
            : "{\"tick\":12}"
        )) };
      };
    const snapshot = await createDockerPublicArtifactSnapshotReader({
      authorityStore: authority(binding),
      context: "gpu-4090",
      contentExecutor,
      executor,
      timeoutMs: 30_000
    }).snapshot(requestFor(binding));
    expect(Buffer.from(snapshot.content_base64, "base64").toString("utf8"))
      .toBe("{\"tick\":12}");
    expect(calls.filter((args) => args[3] === "inspect")).toHaveLength(2);
    expect(contentCalls).toEqual([
      [
        "--context", "gpu-4090", "container", "exec",
        containerId, "/usr/bin/readlink", "-e",
        "/tmp/spawnfile-public/viewer-trace.json"
      ],
      [
        "--context", "gpu-4090", "container", "exec",
        containerId, "/bin/cat", "/tmp/spawnfile-public/viewer-trace.json"
      ]
    ]);
  });

  it("fails closed on correlation drift and oversized copied content", async () => {
    const binding = fixtureBinding();
    const request = requestFor(binding);
    const noCalls: DockerWorldServiceExecutor = async () => {
      throw new Error("provider must not be reached");
    };
    const noContentCalls: DockerTargetExecutors["publicArtifact"] = async () => {
      throw new Error("provider must not be reached");
    };
    await expect(createDockerPublicArtifactSnapshotReader({
      authorityStore: authority(binding),
      context: "gpu-4090",
      contentExecutor: noContentCalls,
      executor: noCalls,
      timeoutMs: 30_000
    }).snapshot({ ...request, run_id: "other-run" })).rejects.toThrow(
      "Target public artifact snapshot failed"
    );
    const spec = worldServiceSpecForBinding(binding);
    const inspectOnly: DockerWorldServiceExecutor = async (_file, args) => {
      if (args[3] === "inspect") {
        return { stderr: "", stdout: JSON.stringify([inspection(spec)]) };
      }
      throw new Error("unexpected provider command");
    };
    const oversized: DockerTargetExecutors["publicArtifact"] =
      async (_file, args) => ({
        bytes: Uint8Array.from(Buffer.from(
          args[5] === "/usr/bin/readlink"
            ? `${request.artifact.path}\n`
            : "x".repeat(request.artifact.max_bytes + 1)
        ))
      });
    await expect(createDockerPublicArtifactSnapshotReader({
      authorityStore: authority(binding),
      context: "gpu-4090",
      contentExecutor: oversized,
      executor: inspectOnly,
      timeoutMs: 30_000
    }).snapshot(request)).rejects.toThrow("Target public artifact snapshot failed");
  });

  it("rejects a declared public path that resolves through any symlink", async () => {
    const binding = fixtureBinding();
    const request = requestFor(binding);
    const spec = worldServiceSpecForBinding(binding);
    const executor: DockerWorldServiceExecutor = async (_file, args) => {
      if (args[3] === "inspect") {
        return { stderr: "", stdout: JSON.stringify([inspection(spec)]) };
      }
      throw new Error("unexpected provider command");
    };
    const calls: string[][] = [];
    const contentExecutor: DockerTargetExecutors["publicArtifact"] =
      async (_file, args) => {
        calls.push([...args]);
        return {
          bytes: Uint8Array.from(Buffer.from(
            "/run/spawnfile-secrets/world-token\n"
          ))
        };
      };
    await expect(createDockerPublicArtifactSnapshotReader({
      authorityStore: authority(binding),
      context: "gpu-4090",
      contentExecutor,
      executor,
      timeoutMs: 30_000
    }).snapshot(request)).rejects.toThrow("Target public artifact snapshot failed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[5]).toBe("/usr/bin/readlink");
  });
});
