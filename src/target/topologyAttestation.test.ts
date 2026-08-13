import { readFile, stat } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseOpaqueTargetHandle } from "./contracts.js";
import { createDockerResourceSpec } from "./dockerResourcesProvider.js";
import { selectTarget } from "./dockerTarget.js";
import { createExistingDockerSecretSpec } from "./dockerSecretsProvider.js";
import { createDockerOrganizationAttachmentSpec } from "./organizationAttachmentProvider.js";
import { createDockerWorldServiceSpec } from "./dockerWorldServiceProvider.js";
import {
  createTargetTopologyAttestor,
  TARGET_TOPOLOGY_ATTESTATION_ERROR
} from "./topologyAttestation.js";

const descriptor = `sha256:${"a".repeat(64)}`;
const bundleDigest = `sha256:${"7".repeat(64)}`;
const imageDigest = `sha256:${"b".repeat(64)}`;
const privateDaemon = `sha256:${"e".repeat(64)}`;
const privateBase = `sha256:${"f".repeat(64)}`;
const privateGc = `spfb_${"9".repeat(58)}`;
const opaque = (character: string) => parseOpaqueTargetHandle(`opaque_${character.repeat(64)}`);
const dataOperation = opaque("c");
const attachmentOperation = opaque("d");
const createOperation = opaque("e");
const startOperation = opaque("f");
const dataRequest = `sha256:${"1".repeat(64)}`;
const attachmentRequest = `sha256:${"2".repeat(64)}`;
const createRequest = `sha256:${"3".repeat(64)}`;
const startRequest = `sha256:${"4".repeat(64)}`;
const labels = {
  "com.spawnfile.compile_fingerprint": "sf1:compile",
  "com.spawnfile.deployment": "deployment",
  "com.spawnfile.project": "project",
  "com.spawnfile.run_id": "run-attest",
  "com.spawnfile.unit": "unit",
  "com.spawnfile.version": "v1"
};

const worldProjection = (spec: ReturnType<typeof createDockerWorldServiceSpec>, changes: Record<string, unknown> = {}) => {
  const source = (path: string): string => spec.createArgs.find((item) => item.includes(`dst=${path}`))!
    .match(/(?:^|,)src=([^,]+)/u)![1]!;
  return JSON.stringify([{
    AutoRemove: false, BindCount: 0, CapAddCount: 0, CapDrop: ["ALL"], CgroupnsMode: "private",
    DeviceCount: 0, DeviceRequestCount: 0, DnsCount: 0, Domainname: "", ExposedPortCount: 0,
    ExtraHostCount: 0, GroupAddCount: 0, Hostname: spec.containerName, Id: "9".repeat(64),
    Image: spec.imageReference, IpcMode: "none", Labels: spec.receiptLabels, LinkCount: 0,
    Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=1m,mode=1777" },
    LogType: "none", Mounts: [
      { Destination: spec.evidenceMountPath, Name: source(spec.evidenceMountPath), RW: true, Type: "volume" },
      { Destination: "/run/spawnfile-secrets", Name: source("/run/spawnfile-secrets"), RW: false, Type: "volume" }
    ], Name: `/${spec.containerName}`, NetworkAttachmentCount: 1,
    NetworkAttachmentId: "1".repeat(64),
    NetworkAttachmentName: spec.createArgs[spec.createArgs.indexOf("--network") + 1],
    NetworkAliases: spec.networkAlias ? [spec.networkAlias] : null,
    NetworkMode: spec.createArgs[spec.createArgs.indexOf("--network") + 1], PidMode: "",
    PortBindingCount: 0, Privileged: false, PublishAllPorts: false, ReadonlyRootfs: true,
    RestartMaximumRetryCount: 0, RestartPolicyName: "no", SecurityOpt: ["no-new-privileges=true"],
    Status: "running", UTSMode: "", UsernsMode: "", VolumesFromCount: 0,
    ...changes
  }]);
};

const setup = async (changes: {
  readonly egressInternal?: boolean;
  readonly hostLike?: boolean;
  readonly organizationNetworks?: number;
  readonly organizationDataNetworkId?: string;
  readonly organizationEgressNetworkId?: string;
  readonly selectionDrift?: boolean;
  readonly worldNetworkId?: string;
  readonly worldInspectionStderr?: string;
  readonly worldInspectionStdout?: string;
  readonly world?: Record<string, unknown>;
  readonly wrongAttachment?: boolean;
  readonly activationFailure?: boolean;
} = {}) => {
  const endpoint = "ssh://attestation.example";
  const selected = await selectTarget({
    context: "target_1", execFile: async () => ({ stderr: "", stdout: JSON.stringify(endpoint) })
  });
  const data = createDockerResourceSpec({
    kind: "data_network", operationHandle: dataOperation, requestDigest: dataRequest,
    runId: "run-attest", selectedTargetHandle: selected.handle
  });
  const attachmentSpec = createDockerOrganizationAttachmentSpec({
    containerId: "8".repeat(64), dataNetworkOperationHandle: dataOperation,
    dataNetworkRequestDigest: dataRequest, deploymentLabels: labels,
    operationHandle: attachmentOperation,
    organizationHandoffHandle: parseOpaqueTargetHandle(`opaque_${"a".repeat(63)}1`),
    requestDigest: attachmentRequest, runId: "run-attest", selectedTargetHandle: selected.handle
  });
  const evidence = createDockerResourceSpec({
    kind: "evidence_volume", operationHandle: opaque("6"),
    requestDigest: `sha256:${"5".repeat(64)}`, runId: "run-attest", selectedTargetHandle: selected.handle
  });
  const secrets = createExistingDockerSecretSpec({
    bindingsHandle: opaque("7"), runId: "run-attest", selectedTargetHandle: selected.handle
  });
  const worldSpec = createDockerWorldServiceSpec({
    dataNetwork: { handle: data.resultHandle, labels: data.labels, name: data.name },
    evidenceMountPath: "/run/world/evidence",
    evidenceVolume: { handle: evidence.resultHandle, labels: evidence.labels, name: evidence.name },
    imageDigest, imageReference: `registry.example/world@${imageDigest}`,
    operationHandle: createOperation, requestDigest: createRequest, runId: "run-attest",
    secretBindings: { handle: secrets.resultHandle, labels: secrets.labels, name: secrets.volumeName },
    selectedTargetHandle: selected.handle
  });
  const request = {
    data_network: { operation_handle: dataOperation, request_digest: dataRequest, result_handle: data.resultHandle },
    descriptor_digest: descriptor,
    organization_attachment: {
      operation_handle: attachmentOperation, request_digest: attachmentRequest,
      result_handle: attachmentSpec.resultHandle
    },
    run_id: "run-attest",
    selected_target: { fingerprint: selected.fingerprint, handle: selected.handle },
    version: "spawnfile.target-topology-attestation.request.v1" as const,
    world_service: {
      create: { operation_handle: createOperation, request_digest: createRequest, result_handle: worldSpec.resultHandle },
      start: { operation_handle: startOperation, request_digest: startRequest, result_handle: worldSpec.resultHandle }
    }
  };
  const attachment = {
    attachment_handle: changes.wrongAttachment ? opaque("0") : request.organization_attachment.result_handle,
    data_network: { handle: data.resultHandle, id: "1".repeat(64), labels: data.labels, name: data.name, operation_handle: dataOperation, request_digest: dataRequest },
    receipt_labels: {},
    resolution: {
      authorization: {
        descriptor_digest: descriptor, operation_handle: attachmentOperation,
        organization_handoff_handle: parseOpaqueTargetHandle(`opaque_${"a".repeat(63)}1`), request_digest: attachmentRequest,
        run_id: "run-attest", selected_target: request.selected_target,
        version: "spawnfile.target-organization-attachment.authorization.v1"
      },
      network_attachment: { container_id: "8".repeat(64), deployment_labels: labels, network_attachment_handle: opaque("1") }
    }
  };
  const world = {
    container_id: "9".repeat(64),
    resources: {
      data_network: { handle: data.resultHandle, labels: data.labels, name: data.name },
      evidence_volume: { handle: evidence.resultHandle, labels: evidence.labels, name: evidence.name },
      secret_bindings: { handle: secrets.resultHandle, labels: secrets.labels, name: secrets.volumeName }
    },
    resolution: {
      artifact: { artifact_manifest_digest: bundleDigest,
        base_image_config_digest: privateBase, config_id: imageDigest,
        daemon_epoch: privateDaemon, gc_tag: privateGc,
        image_digest: imageDigest, image_reference: `registry.example/world@${imageDigest}` },
      authorization: {
        data_network_handle: data.resultHandle, descriptor_digest: descriptor,
        evidence_mount_path: "/run/world/evidence",
        evidence_volume_handle: evidence.resultHandle, operation_handle: createOperation,
        request_digest: createRequest, run_id: "run-attest", secret_bindings_handle: secrets.resultHandle,
        selected_target: request.selected_target, world_artifact_handle: opaque("a")
      }
    },
    world_service_handle: worldSpec.resultHandle
  };
  const receiptFor = (operation: string, tuple: { operation_handle: string; request_digest: string; result_handle: string }) => ({
    descriptor_digest: descriptor, operation, operation_handle: tuple.operation_handle,
    request_digest: tuple.request_digest, result_handle: tuple.result_handle, run_id: "run-attest",
    selected_target: request.selected_target
  });
  const records = new Map([
    [`${dataOperation}\0${dataRequest}`, receiptFor("create_data_network", request.data_network)],
    [`${attachmentOperation}\0${attachmentRequest}`, receiptFor("attach_organization", request.organization_attachment)],
    [`${createOperation}\0${createRequest}`, receiptFor("create_world_service", request.world_service.create)],
    [`${startOperation}\0${startRequest}`, receiptFor("start_world_service", request.world_service.start)]
  ]);
  let contextInspections = 0;
  let activationBytes: string | undefined;
  let activationAttempts = 0;
  let activationModes: { readonly directory: number; readonly file: number } | undefined;
  let snapshotArgs: readonly string[] | undefined;
  const assertSnapshot = (args: readonly string[]) => {
    expect(args[0]).toBe("--config");
    expect(args[1]).toMatch(/spawnfile-docker-context-/u);
    expect(args[2]).toBe("--context");
    expect(args[3]).toMatch(/^spfn_[a-f0-9]{32}$/u);
    snapshotArgs ??= args.slice(0, 4);
    expect(args.slice(0, 4)).toEqual(snapshotArgs);
  };
  const resourceExecutor = async (_file: string, args: string[]) => {
    if (args[0] === "context") {
      contextInspections += 1;
      return { stderr: "", stdout: JSON.stringify([{
        Endpoints: { docker: { Host: changes.selectionDrift ? "ssh://other.example" : endpoint, SkipTLSVerify: false } },
        Metadata: {}, Name: "target_1", Storage: { MetadataPath: "<IN MEMORY>", TLSPath: "<IN MEMORY>" }, TLSMaterial: { docker: [] }
      }]) };
    }
    return { stderr: "", stdout: JSON.stringify([{ Id: "1".repeat(64), Internal: true, Labels: data.labels, Name: data.name }]) };
  };
  const attachmentExecutor = async (_file: string, args: string[]) => {
    assertSnapshot(args);
    if (args[4] === "container") return { stderr: "", stdout: JSON.stringify([{
      DataAttached: true, DataNetworkId: changes.organizationDataNetworkId ?? "1".repeat(64),
      EgressNetworkId: changes.organizationEgressNetworkId ?? "b".repeat(64), EgressNetworkName: "owner-egress",
      Id: "8".repeat(64), Labels: labels,
      NetworkAttachmentCount: changes.organizationNetworks ?? 2, NetworkMode: changes.hostLike ? "host" : "owner-egress"
    }]) };
    if (args.includes("owner-egress")) return { stderr: "", stdout: JSON.stringify([{
      Id: changes.organizationEgressNetworkId ?? "b".repeat(64), Internal: changes.egressInternal ?? false, Name: "owner-egress"
    }]) };
    return { stderr: "", stdout: JSON.stringify([{ Id: "1".repeat(64), Internal: true, Labels: data.labels, Name: data.name }]) };
  };
  const attestor = createTargetTopologyAttestor({
    attachmentExecutor, attachmentStore: { loadAttachment: async () => attachment } as never,
    context: "target_1", resourceExecutor,
    resolveJournal: async () => ({
      resolveCompletedReceipt: async (claim: { operationHandle: string; requestDigest: string }) => {
        const receipt = records.get(`${claim.operationHandle}\0${claim.requestDigest}`);
        return receipt ? { receipt, receiptBytes: "private" } : null;
      },
      withLifecycleLease: async <Result>(action: () => Promise<Result>): Promise<Result> => action()
    }) as never,
    timeoutMs: 10_000,
    worldExecutor: async (_file, args) => {
      assertSnapshot(args);
      if (args[4] === "container" && args[5] === "cp") {
        activationAttempts += 1;
        if (changes.activationFailure) throw new Error("private copy failure");
        activationModes = {
          directory: (await stat(args[6]!)).mode & 0o777,
          file: (await stat(`${args[6]!}/world-service-activated.v1`)).mode & 0o777
        };
        activationBytes = await readFile(
          `${args[6]!}/world-service-activated.v1`,
          "utf8"
        );
        expect(args[7]).toBe(`${"9".repeat(64)}:/run/world/evidence`);
        return { stderr: "", stdout: "" };
      }
      return {
        stderr: changes.worldInspectionStderr ?? "",
        stdout: changes.worldInspectionStdout
          ?? worldProjection(worldSpec, { NetworkAttachmentId: changes.worldNetworkId ?? "1".repeat(64), ...changes.world })
      };
    },
    worldStore: { loadService: async () => world } as never
  });
  return {
    activationBytes: () => activationBytes,
    activationAttempts: () => activationAttempts,
    activationModes: () => activationModes,
    attestor,
    contextInspections: () => contextInspections,
    request
  };
};

describe("owner target topology attestation", () => {
  it("rejects hostile constructor envelopes before evaluating getters", () => {
    let reads = 0;
    const getter = Object.defineProperty({}, "context", {
      enumerable: true, get: () => { reads += 1; return "target_1"; }
    });
    for (const hostile of [getter, new Proxy({}, {})]) {
      expect(() => createTargetTopologyAttestor(hostile as never))
        .toThrow(TARGET_TOPOLOGY_ATTESTATION_ERROR);
    }
    expect(reads).toBe(0);
  });

  it("proves an exact private topology and returns a canonical semantic-only receipt", async () => {
    const { attestor, request } = await setup();
    const result = await attestor.attest(request);
    expect(result.receiptBytes).toBe(JSON.stringify(result.receipt));
    expect(result.receipt).toMatchObject({
      organization: { data_network_attachment: "exact", egress_policy: "egress_only" },
      service_discovery: "dns_only", world_network: "private_internal",
      world_service: { data_network_attachment: "exactly_one", egress_policy: "none", published_ports: "none" }
    });
    for (const privateValue of ["owner-egress", "ssh://", "8".repeat(64), "9".repeat(64),
      dataOperation, imageDigest, privateDaemon, privateBase, privateGc]) {
      expect(result.receiptBytes).not.toContain(privateValue);
    }
  });

  it("fails closed for egress, host-like, attachment, current-target, and world drift", async () => {
    for (const changes of [
      { egressInternal: true }, { hostLike: true }, { organizationNetworks: 3 },
      { organizationDataNetworkId: "0".repeat(64) }, { worldNetworkId: "0".repeat(64) },
      { wrongAttachment: true }, { selectionDrift: true },
      { world: { Status: "created" } }, { world: { PortBindingCount: 1 } },
      { world: { NetworkAttachmentCount: 2 } }
    ]) {
      const { attestor, request } = await setup(changes);
      await expect(attestor.attest(request)).rejects.toThrow(TARGET_TOPOLOGY_ATTESTATION_ERROR);
    }
  });

  it("reports four distinct world inspection reasons and preserves stderr", async () => {
    const cases = [
      { changes: { worldInspectionStderr: "remote warning: inspect retry" }, reason: "world_service_inspection_stderr:remote warning: inspect retry" },
      { changes: { worldInspectionStdout: "not-json" }, reason: "world_service_inspection_unparseable" },
      { changes: { world: { Status: "created" } }, reason: "world_service_status_mismatch" },
      { changes: { world: { Id: "8".repeat(64) } }, reason: "world_service_container_id_mismatch" },
      { changes: { worldNetworkId: "0".repeat(64) }, reason: "world_service_network_id_mismatch" }
    ];
    const messages: string[] = [];
    for (const testCase of cases) {
      const value = await setup(testCase.changes);
      await expect(value.attestor.attest(value.request)).rejects.toThrow(
        `${TARGET_TOPOLOGY_ATTESTATION_ERROR}: ${testCase.reason}`
      );
      messages.push(testCase.reason);
    }
    expect(new Set(messages).size).toBe(cases.length);
  });

  it("resolves the named context once then binds every topology read to one private context snapshot", async () => {
    const { attestor, contextInspections, request } = await setup();
    await expect(attestor.attest(request)).resolves.toBeDefined();
    expect(contextInspections()).toBe(1);
  });

  it("re-proves topology then publishes one exact generic owner activation", async () => {
    const { activationBytes, attestor, contextInspections, request } = await setup();
    const result = await attestor.activate(request);
    expect(contextInspections()).toBe(1);
    expect(JSON.parse(activationBytes()!)).toEqual({
      bundle_digest: bundleDigest,
      run_id: "run-attest",
      state: "activated",
      topology_receipt_digest: result.receipt.topology_receipt_digest,
      topology_request_digest: result.receipt.topology_request_digest,
      version: "spawnfile.world-service-activation.v1"
    });
    expect(activationBytes()).toMatch(/\n$/u);
    expect(result.receipt).toMatchObject({
      bundle_digest: bundleDigest,
      run_id: "run-attest",
      state: "activated",
      version: "spawnfile.target-topology-activation-receipt.v1"
    });
  });

  it("stages activation evidence readable by the unprivileged exporter", async () => {
    const { activationModes, attestor, request } = await setup();
    await attestor.activate(request);
    expect(activationModes()).toEqual({ directory: 0o755, file: 0o644 });
    expect(activationModes()!.directory & 0o005).toBe(0o005);
    expect(activationModes()!.file & 0o004).toBe(0o004);
  });

  it("never emits an activation receipt when owner publication fails", async () => {
    const { activationAttempts, attestor, request } =
      await setup({ activationFailure: true });
    await expect(attestor.activate(request)).rejects.toThrow(
      TARGET_TOPOLOGY_ATTESTATION_ERROR
    );
    expect(activationAttempts()).toBe(1);
  });

  it("never publishes activation when the exact topology proof fails", async () => {
    const { activationAttempts, attestor, request } =
      await setup({ world: { PortBindingCount: 1 } });
    await expect(attestor.activate(request)).rejects.toThrow(
      TARGET_TOPOLOGY_ATTESTATION_ERROR
    );
    expect(activationAttempts()).toBe(0);
  });
});
