import { describe, expect, it } from "vitest";

import { parseOpaqueTargetHandle } from "./contracts.js";
import { createDockerArtifactSpec } from "./dockerArtifactsProvider.js";
import { createDockerResourceSpec } from "./dockerResourcesProvider.js";
import { createExistingDockerSecretSpec } from "./dockerSecretsProvider.js";
import { createWorldServiceAuthorization } from "./dockerWorldServiceAuthority.js";
import {
  removeExactDockerWorldService,
  worldServiceSpecForBinding
} from "./dockerWorldServiceLifecycle.js";
import {
  DockerWorldServiceProviderError,
  type DockerWorldServiceExecutor,
  type DockerWorldServiceInspection,
  type DockerWorldServiceSpec
} from "./dockerWorldServiceProvider.js";
import {
  createWorldServiceBinding,
  type WorldServiceBinding
} from "./dockerWorldServiceStore.js";

const h = (value: string) => parseOpaqueTargetHandle(`opaque_${value.repeat(64).slice(0, 64)}`);
const d = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
const containerId = "c".repeat(64);
const binding = (): WorldServiceBinding => {
  const selectedTargetHandle = h("1");
  const network = createDockerResourceSpec({ kind: "data_network", operationHandle: h("2"),
    requestDigest: d("2"), runId: "run-cleanup", selectedTargetHandle });
  const evidence = createDockerResourceSpec({ kind: "evidence_volume", operationHandle: h("3"),
    requestDigest: d("3"), runId: "run-cleanup", selectedTargetHandle });
  const secrets = createExistingDockerSecretSpec({ bindingsHandle: h("4"),
    runId: "run-cleanup", selectedTargetHandle });
  const artifact = createDockerArtifactSpec({
    artifactManifestDigest: d("5"), imageDigest: d("6"),
    imageReference: `registry.example/world@${d("6")}`, operationHandle: h("7"),
    requestDigest: d("7"), selectedTargetHandle
  });
  const authorization = createWorldServiceAuthorization({
    dataNetworkHandle: network.resultHandle, descriptorDigest: d("8"),
    evidenceMountPath: "/run/world/evidence",
    evidenceVolumeHandle: evidence.resultHandle, operationHandle: h("9"),
    requestDigest: d("9"), runId: "run-cleanup", secretBindingsHandle: secrets.resultHandle,
    selectedTarget: { fingerprint: `sha256:${"a".repeat(32)}`, handle: selectedTargetHandle },
    worldArtifactHandle: artifact.resultHandle
  });
  const resolution = Object.freeze({
    artifact: Object.freeze({
      artifact_manifest_digest: d("5"), image_digest: d("6"),
      image_reference: `registry.example/world@${d("6")}`,
      operation_handle: h("7"), request_digest: d("7"), result_handle: artifact.resultHandle
    }),
    authorization
  });
  const resources = Object.freeze({
    data_network: Object.freeze({ handle: network.resultHandle, labels: network.labels, name: network.name }),
    evidence_volume: Object.freeze({ handle: evidence.resultHandle, labels: evidence.labels, name: evidence.name }),
    secret_bindings: Object.freeze({ handle: secrets.resultHandle, labels: secrets.labels, name: secrets.volumeName })
  });
  const spec = worldServiceSpecForBinding({ resolution, resources });
  return createWorldServiceBinding({ containerId, dataNetwork: resources.data_network,
    evidenceVolume: resources.evidence_volume, resolution, secretBindings: resources.secret_bindings, spec });
};

const after = (args: readonly string[], flag: string): string => {
  const value = args[args.indexOf(flag) + 1];
  if (!value) throw new Error(`missing ${flag}`);
  return value;
};
const projection = (
  spec: DockerWorldServiceSpec,
  status: DockerWorldServiceInspection["status"],
  drift = false
) => ({
  AutoRemove: false, BindCount: 0, CapAddCount: 0, CapDrop: ["ALL"],
  CgroupnsMode: "private", DeviceCount: 0, DeviceRequestCount: 0, DnsCount: 0,
  Domainname: "", ExposedPortCount: 0, ExtraHostCount: 0, GroupAddCount: 0,
  Hostname: spec.containerName, Id: containerId, Image: spec.imageReference, IpcMode: "none",
  Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=1m,mode=1777" },
  Labels: drift ? { ...spec.receiptLabels, extra: "foreign" } : spec.receiptLabels,
  LinkCount: 0, LogType: "none",
  Mounts: spec.createArgs.filter((value, index, values) => values[index - 1] === "--mount")
    .map((value) => Object.fromEntries(value.split(",").map((part) => part.split("=", 2))))
    .map((mount) => ({ Destination: mount.dst, Name: mount.src,
      RW: mount.dst === spec.evidenceMountPath, Type: "volume" })),
  Name: `/${spec.containerName}`, NetworkAttachmentCount: 1, NetworkAttachmentId: "b".repeat(64),
  NetworkAttachmentName: after(spec.createArgs, "--network"),
  NetworkAliases: spec.networkAlias ? [spec.networkAlias] : null,
  NetworkMode: after(spec.createArgs, "--network"), PidMode: "", PortBindingCount: 0,
  Privileged: false, PublishAllPorts: false, ReadonlyRootfs: true,
  RestartMaximumRetryCount: 0, RestartPolicyName: "no",
  SecurityOpt: ["no-new-privileges=true"], Status: status,
  UTSMode: "", UsernsMode: "", VolumesFromCount: 0
});

type Behavior = "absent" | "bad_ack" | "present" | "success" | "success_present" | "transition";
const fixture = (input: {
  readonly drift?: boolean;
  readonly initial?: DockerWorldServiceInspection["status"] | "absent";
  readonly remove?: Behavior | "foreign";
  readonly stop?: Behavior;
}) => {
  const value = binding();
  const spec = worldServiceSpecForBinding(value);
  const calls: string[][] = [];
  const commandOptions: Array<{ readonly signal?: AbortSignal; readonly timeout: number }> = [];
  let status = input.initial ?? "running";
  let drift = input.drift ?? false;
  const executor: DockerWorldServiceExecutor = async (_file, args, options) => {
    calls.push(args);
    commandOptions.push(options);
    if (args[2] === "container" && args[3] === "inspect") {
      if (args[args.length - 1] !== containerId) throw new Error("non-authoritative reference");
      if (status === "absent") throw new DockerWorldServiceProviderError("not_found");
      return { stderr: "", stdout: JSON.stringify([projection(spec, status, drift)]) };
    }
    if (args[2] === "container" && args[3] === "stop") {
      if (input.stop === "present") throw new Error("transport");
      if (input.stop === "absent") {
        status = "absent";
        throw new DockerWorldServiceProviderError("not_found");
      }
      status = "exited";
      if (input.stop === "transition") throw new Error("transport");
      return { stderr: "", stdout: input.stop === "bad_ack" ? "" : `${containerId}\n` };
    }
    if (args[2] === "container" && args[3] === "rm") {
      if (input.remove === "present") throw new Error("transport");
      if (input.remove === "foreign") {
        drift = true;
        throw new Error("transport");
      }
      status = input.remove === "absent" || input.remove === "transition"
        || input.remove === undefined || input.remove === "success" ? "absent" : status;
      if (input.remove === "absent") {
        throw new DockerWorldServiceProviderError("not_found");
      }
      if (input.remove === "transition") throw new Error("transport");
      return { stderr: "", stdout: input.remove === "bad_ack" ? "" : `${containerId}\n` };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  return { calls, commandOptions, executor, value };
};

const run = (value: ReturnType<typeof fixture>, signal?: AbortSignal) =>
  removeExactDockerWorldService(value.value, {
    context: "production", executor: value.executor, signal, timeoutMs: 10_000
  });

describe("exact Docker world-service cleanup", () => {
  it.each(["running", "paused", "restarting"] as const)(
    "stops active %s service, removes it once, and proves exact absence",
    async (initial) => {
      const value = fixture({ initial });
      const signal = new AbortController().signal;
      await expect(run(value, signal)).resolves.toBeUndefined();
      expect(value.calls).toEqual([
        ["--context", "production", "container", "inspect", "--format",
          worldServiceSpecForBinding(value.value).inspectionFormat, containerId],
        ["--context", "production", "container", "stop", "--timeout", "10", containerId],
        ["--context", "production", "container", "inspect", "--format",
          worldServiceSpecForBinding(value.value).inspectionFormat, containerId],
        ["--context", "production", "container", "rm", containerId],
        ["--context", "production", "container", "inspect", "--format",
          worldServiceSpecForBinding(value.value).inspectionFormat, containerId]
      ]);
      expect(value.calls.flat()).not.toEqual(expect.arrayContaining([
        "list", "ps", "filter", "prune", "--force"
      ]));
      expect(value.commandOptions.every((options) =>
        options.signal === signal && options.timeout === 10_000)).toBe(true);
    }
  );

  it.each(["created", "exited", "dead"] as const)("skips stop for %s and removes once", async (initial) => {
    const value = fixture({ initial });
    await expect(run(value)).resolves.toBeUndefined();
    expect(value.calls.filter((args) => args[3] === "stop")).toHaveLength(0);
    expect(value.calls.filter((args) => args[3] === "rm")).toHaveLength(1);
  });

  it("converges for an absent exact container", async () => {
    const value = fixture({ initial: "absent" });
    await expect(run(value)).resolves.toBeUndefined();
    expect(value.calls).toHaveLength(1);
  });

  it("rejects a removing container without stop or remove", async () => {
    const value = fixture({ initial: "removing" });
    await expect(run(value)).rejects.toThrow("Docker world-service lifecycle failed");
    expect(value.calls).toHaveLength(1);
  });

  it("rejects drift and option-like forged bindings before mutation", async () => {
    const drift = fixture({ drift: true });
    await expect(run(drift)).rejects.toThrow("Docker world-service lifecycle failed");
    expect(drift.calls).toHaveLength(1);
    const forged = fixture({});
    await expect(removeExactDockerWorldService({ ...forged.value, container_id: "--force" }, {
      context: "production", executor: forged.executor, timeoutMs: 10_000
    })).rejects.toThrow("Docker world-service lifecycle failed");
    expect(forged.calls).toHaveLength(0);
  });

  it("reconciles stop ambiguity only after exact transition or absence", async () => {
    const transitioned = fixture({ stop: "transition" });
    await expect(run(transitioned)).resolves.toBeUndefined();
    expect(transitioned.calls.filter((args) => args[3] === "stop")).toHaveLength(1);
    expect(transitioned.calls.filter((args) => args[3] === "rm")).toHaveLength(1);
    const absent = fixture({ stop: "absent" });
    await expect(run(absent)).resolves.toBeUndefined();
    expect(absent.calls.filter((args) => args[3] === "rm")).toHaveLength(0);
    const present = fixture({ stop: "present" });
    await expect(run(present)).rejects.toThrow("Docker world-service lifecycle failed");
    expect(present.calls.filter((args) => args[3] === "rm")).toHaveLength(0);
    const badAck = fixture({ stop: "bad_ack" });
    await expect(run(badAck)).rejects.toThrow("Docker world-service lifecycle failed");
    expect(badAck.calls).toHaveLength(2);
  });

  it("reconciles remove ambiguity only to absence and rejects replacements", async () => {
    for (const behavior of ["absent", "transition"] as const) {
      const value = fixture({ initial: "exited", remove: behavior });
      await expect(run(value)).resolves.toBeUndefined();
      expect(value.calls.filter((args) => args[3] === "rm")).toHaveLength(1);
    }
    const present = fixture({ initial: "exited", remove: "present" });
    await expect(run(present)).rejects.toThrow("Docker world-service lifecycle failed");
    expect(present.calls.filter((args) => args[3] === "rm")).toHaveLength(1);
    const exactReplacement = fixture({ initial: "exited", remove: "success_present" });
    await expect(run(exactReplacement)).rejects.toThrow("Docker world-service lifecycle failed");
    expect(exactReplacement.calls.filter((args) => args[3] === "rm")).toHaveLength(1);
    const foreign = fixture({ initial: "exited", remove: "foreign" });
    await expect(run(foreign)).rejects.toThrow("Docker world-service lifecycle failed");
    expect(foreign.calls.filter((args) => args[3] === "rm")).toHaveLength(1);
    const badAck = fixture({ initial: "exited", remove: "bad_ack" });
    await expect(run(badAck)).rejects.toThrow("Docker world-service lifecycle failed");
    expect(badAck.calls).toHaveLength(2);
  });
});
