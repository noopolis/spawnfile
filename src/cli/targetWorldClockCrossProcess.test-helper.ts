import { chmod, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseOpaqueTargetHandle } from "../target/contracts.js";
import { createDockerArtifactSpec } from "../target/dockerArtifactsProvider.js";
import { createDockerResourceSpec } from "../target/dockerResourcesProvider.js";
import { createExistingDockerSecretSpec } from "../target/dockerSecretsProvider.js";
import { createWorldServiceAuthorization, parseWorldServiceResolution } from "../target/dockerWorldServiceAuthority.js";
import { worldServiceSpecForBinding } from "../target/dockerWorldServiceLifecycle.js";
import type { DockerWorldServiceSpec } from "../target/dockerWorldServiceProvider.js";
import {
  createWorldServiceBinding,
  initializeWorldServiceAuthorityStore,
  worldServiceResourceBindings,
} from "../target/dockerWorldServiceStore.js";
import {
  createCanonicalWorldServiceActivationBytes,
  createTargetTopologyActivationReceiptDigest,
  createWorldServiceActivationDigest,
  parseWorldServiceActivation,
} from "../target/topologyActivation.js";
import { parseTargetWorldClockRequest, type TargetWorldClockRequest } from "../target/worldClock.js";

export type BuiltWorldClockMode = "success" | "tick-zero" | "stale" | "topology" | "activation" | "nonzero-action";
export interface BuiltWorldClockState {
  readonly callsPath: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly home: string;
  readonly modePath: string;
  readonly request: TargetWorldClockRequest;
  readonly requestPath: string;
  readonly root: string;
}

const d = (value: string): `sha256:${string}` => `sha256:${value.repeat(64).slice(0, 64)}`;
const h = (value: string) => parseOpaqueTargetHandle(`opaque_${value.repeat(16)}`);
const containerId = "c".repeat(64);
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
  SecurityOpt: ["no-new-privileges=true"], Status: "running", Tmpfs: {
    "/tmp": "rw,noexec,nosuid,nodev,size=1m,mode=1777",
    "/tmp/spawnfile-public": "rw,noexec,nosuid,nodev,size=1m,mode=1777"
  },
  UTSMode: "", UsernsMode: "", VolumesFromCount: 0,
});

const fixture = () => {
  const selectedTarget = { fingerprint: `sha256:${"1".repeat(32)}`, handle: h("1") };
  const runId = "run-built-clock";
  const dataClaim = { operationHandle: h("2"), requestDigest: d("2") };
  const evidenceClaim = { operationHandle: h("3"), requestDigest: d("3") };
  const data = createDockerResourceSpec({ kind: "data_network", ...dataClaim, runId, selectedTargetHandle: selectedTarget.handle });
  const evidence = createDockerResourceSpec({ kind: "evidence_volume", ...evidenceClaim, runId, selectedTargetHandle: selectedTarget.handle });
  const artifact = createDockerArtifactSpec({ artifactManifestDigest: d("4"), imageDigest: d("5"),
    imageReference: `registry.example/world@${d("5")}`, operationHandle: h("4"), requestDigest: d("4"),
    selectedTargetHandle: selectedTarget.handle });
  const authorization = createWorldServiceAuthorization({ dataNetworkHandle: data.resultHandle, descriptorDigest: d("6"),
    evidenceMountPath: "/run/world/evidence", evidenceVolumeHandle: evidence.resultHandle, operationHandle: h("6"),
    requestDigest: d("6"), runId, secretBindingsHandle: h("7"), selectedTarget, worldArtifactHandle: artifact.resultHandle });
  const resolution = parseWorldServiceResolution({ artifact: { artifact_manifest_digest: d("4"), identity_kind: "oci_image_manifest",
    image_digest: artifact.imageDigest, image_reference: artifact.imageReference, operation_handle: h("4"),
    request_digest: d("4"), result_handle: artifact.resultHandle }, authorization });
  const resources = worldServiceResourceBindings({ dataNetworkClaim: dataClaim, evidenceVolumeClaim: evidenceClaim, resolution });
  const spec = worldServiceSpecForBinding({ resolution, resources });
  const binding = createWorldServiceBinding({ containerId, dataNetwork: resources.data_network, evidenceVolume: resources.evidence_volume,
    resolution, secretBindings: resources.secret_bindings, spec });
  const marker = parseWorldServiceActivation({ bundle_digest: d("8"), run_id: runId, state: "activated",
    topology_receipt_digest: d("9"), topology_request_digest: d("a"), version: "spawnfile.world-service-activation.v1" });
  const activationDigest = createWorldServiceActivationDigest(marker);
  const activationReceiptDigest = createTargetTopologyActivationReceiptDigest({ activation_digest: activationDigest,
    bundle_digest: marker.bundle_digest, receipt_digest: d("0"), run_id: runId, state: "activated",
    topology_receipt_digest: marker.topology_receipt_digest, topology_request_digest: marker.topology_request_digest,
    version: "spawnfile.target-topology-activation-receipt.v1" });
  const request = parseTargetWorldClockRequest({ activation_digest: activationDigest,
    activation_receipt_digest: activationReceiptDigest, descriptor_digest: authorization.descriptor_digest,
    endpoint: { internal_port: 4_070, path: "/v1/world/clock" },
    expected: { document_version: "world.clock-document.v1", world_instance_id: "world-built-clock" }, run_id: runId,
    selected_target: selectedTarget, topology_receipt_digest: marker.topology_receipt_digest,
    topology_request_digest: marker.topology_request_digest, version: "spawnfile.target-world-clock.request.v1",
    world_service_handle: binding.world_service_handle });
  return { binding, marker, request, spec };
};

export const createBuiltWorldClockState = async (): Promise<BuiltWorldClockState> => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-built-world-clock-")));
  const home = path.join(root, "home"); const callsPath = path.join(root, "docker-calls.ndjson");
  const modePath = path.join(root, "mode"); const scenariosPath = path.join(root, "scenarios.json");
  const fakeDocker = path.join(root, "docker-clock"); const requestPath = path.join(root, "request.json");
  const { binding, marker, request, spec } = fixture();
  const store = await initializeWorldServiceAuthorityStore(path.join(home, "target", "world-authority"));
  await store.bindService(binding);
  const observation = { action_count: 0, clock: { completed_tick: 1, next_tick: 2, state: "running" },
    run_id: request.run_id, version: request.expected.document_version, world_instance_id: request.expected.world_instance_id };
  const topologyMarker = parseWorldServiceActivation({ ...marker, topology_receipt_digest: d("b") });
  const activationMarker = parseWorldServiceActivation({ ...marker, bundle_digest: d("c") });
  const scenarios = {
    success: { marker: createCanonicalWorldServiceActivationBytes(marker), observation: JSON.stringify(observation) },
    "tick-zero": { marker: createCanonicalWorldServiceActivationBytes(marker), observation: JSON.stringify({ ...observation,
      clock: { completed_tick: 0, next_tick: 1, state: "running" } }) },
    stale: { marker: createCanonicalWorldServiceActivationBytes(marker), observation: JSON.stringify({ ...observation, run_id: "run-stale-clock" }) },
    topology: { marker: createCanonicalWorldServiceActivationBytes(topologyMarker), observation: JSON.stringify(observation) },
    activation: { marker: createCanonicalWorldServiceActivationBytes(activationMarker), observation: JSON.stringify(observation) },
    "nonzero-action": { marker: createCanonicalWorldServiceActivationBytes(marker), observation: JSON.stringify({ ...observation, action_count: 1 }) },
  };
  await writeFile(callsPath, "", { mode: 0o600 }); await writeFile(modePath, "success", { mode: 0o600 });
  await writeFile(scenariosPath, JSON.stringify(scenarios), { mode: 0o600 });
  await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
  await writeFile(fakeDocker, `#!${process.execPath}
const fs=require("node:fs");const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(args)+"\\n");
const all=JSON.parse(fs.readFileSync(${JSON.stringify(scenariosPath)},"utf8"));
const current=all[fs.readFileSync(${JSON.stringify(modePath)},"utf8").trim()];
if(args[2]==="container"&&args[3]==="inspect")process.stdout.write(${JSON.stringify(JSON.stringify([inspection(spec)]))});
else if(args[2]==="container"&&args[3]==="exec"&&args.includes("/bin/cat"))process.stdout.write(current.marker);
else if(args[2]==="container"&&args[3]==="exec"&&args.includes("/usr/local/bin/node"))process.stdout.write(current.observation);
else{process.stderr.write("unexpected fake Docker command\\n");process.exitCode=71;}
`, { mode: 0o700 });
  await chmod(fakeDocker, 0o700);
  return { callsPath, config: { context: "built_clock", dockerCommand: fakeDocker,
    evidenceDestination: path.join(root, "unused.tar"), timeoutMs: 10_000,
    version: "spawnfile.target-default-config.v1" }, home, modePath, request, requestPath, root };
};

export const selectBuiltWorldClockMode = async (
  state: BuiltWorldClockState,
  mode: BuiltWorldClockMode,
): Promise<void> => { await writeFile(state.modePath, mode, { mode: 0o600 }); };
