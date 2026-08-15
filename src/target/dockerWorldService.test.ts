import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TARGET_RESOURCE_REQUEST_VERSION,
  parseTargetResourceRequest,
  type OpaqueTargetHandle,
  type SelectedTargetReceipt
} from "./contracts.js";
import { createDockerArtifactSpec, createDockerConfigArtifactSpec } from "./dockerArtifactsProvider.js";
import { createDockerResourceSpec, type DockerResourceSpec } from "./dockerResourcesProvider.js";
import { createPreparedDockerSecretSpec, type DockerSecretSpec } from "./dockerSecretsProvider.js";
import { selectTarget } from "./dockerTarget.js";
import { createDockerWorldServiceOperations } from "./dockerWorldService.js";
import { createWorldServiceReceipt, worldServiceSpecForBinding } from "./dockerWorldServiceLifecycle.js";
import {
  createWorldServiceAuthorization,
  parseWorldServiceResolution,
  type WorldServiceAuthorization,
  type WorldServiceResolution
} from "./dockerWorldServiceAuthority.js";
import {
  DockerWorldServiceProviderError,
  createDockerWorldServiceSpec,
  type DockerWorldServiceExecutor,
  type DockerWorldServiceSpec
} from "./dockerWorldServiceProvider.js";
import { initializeWorldServiceAuthorityStore } from "./dockerWorldServiceStore.js";
import { createTargetReceiptDigest } from "./handles.js";
import { initializeTargetJournal, type TargetJournalStore } from "./journal.js";

const context = "gpu-host";
const endpoint = "ssh://operator@gpu-host";
const runId = "run-world-service";
const descriptor = `sha256:${"d".repeat(64)}`;
const manifest = `sha256:${"a".repeat(64)}`;
const imageDigest = `sha256:${"b".repeat(64)}`;
const imageReference = `registry.example/sim/world@${imageDigest}`;
const containerId = "c".repeat(64);
const roots: string[] = [];
const key = (index: number): string => `idem_${String(index).padStart(16, "a")}`;
const temporaryRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-world-service-")));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    force: true, maxRetries: 3, recursive: true, retryDelay: 10
  })));
});

interface Deferred { readonly promise: Promise<void>; release(): void }
const deferred = (): Deferred => {
  let release!: () => void;
  return { promise: new Promise<void>((resolve) => { release = resolve; }), release };
};

interface Seeded {
  readonly artifact: ReturnType<typeof createDockerArtifactSpec> & {
    readonly operationHandle: OpaqueTargetHandle;
    readonly requestDigest: string;
  };
  readonly journal: TargetJournalStore;
  readonly network: DockerResourceSpec;
  readonly evidence: DockerResourceSpec;
  readonly secrets: DockerSecretSpec;
  readonly selected: SelectedTargetReceipt;
}

const seedJournal = async (root: string): Promise<Seeded> => {
  const selected = await selectTarget({
    context,
    execFile: async () => ({ stderr: "", stdout: JSON.stringify(endpoint) })
  });
  const selectedTarget = { fingerprint: selected.fingerprint, handle: selected.handle };
  const journal = await initializeTargetJournal({
    context, descriptorDigest: descriptor, root: path.join(root, "journal"), runId,
    selectedTarget: selected
  });
  const envelope = (revision: number, index: number) => ({
    descriptor_digest: descriptor,
    expected_revision: revision,
    idempotency_key: key(index),
    run_id: runId,
    selected_target: selectedTarget,
    version: TARGET_RESOURCE_REQUEST_VERSION
  });

  const artifactRequest = {
    ...envelope(0, 1), artifact_manifest_digest: manifest,
    operation: "resolve_world_artifact" as const
  };
  const artifactReservation = await journal.reserve(artifactRequest);
  if (artifactReservation.kind !== "owner") throw new Error("expected artifact owner");
  const artifactSpec = createDockerArtifactSpec({
    artifactManifestDigest: manifest,
    imageDigest,
    imageReference,
    operationHandle: artifactReservation.claim.operationHandle,
    requestDigest: artifactReservation.claim.requestDigest,
    selectedTargetHandle: selected.handle
  });
  const artifactReceipt = {
    cleanup_state: "not_requested", descriptor_digest: descriptor,
    export_state: "not_requested", labels: Object.entries(artifactSpec.labels).map(([name, value]) => ({ key: name, value })),
    operation: artifactRequest.operation, operation_handle: artifactReservation.claim.operationHandle,
    receipt_digest: `sha256:${"0".repeat(64)}`, request_digest: artifactReservation.claim.requestDigest,
    result_handle: artifactSpec.resultHandle, resulting_revision: 1, run_id: runId,
    selected_target: selectedTarget, version: "spawnfile.target-resource.receipt.v1"
  } as const;
  await journal.complete(artifactReservation.claim, {
    ...artifactReceipt, receipt_digest: createTargetReceiptDigest(artifactReceipt)
  });

  const secretRequest = {
    ...envelope(1, 2), bindings: [{
      name: "world", scope: "runtime",
      source_handle: "opaque_sourcehandle0001" as OpaqueTargetHandle
    }], operation: "prepare_secret_bindings" as const
  };
  const secretReservation = await journal.reserve(secretRequest);
  if (secretReservation.kind !== "owner") throw new Error("expected secret owner");
  const secrets = createPreparedDockerSecretSpec({
    operationHandle: secretReservation.claim.operationHandle,
    requestDigest: secretReservation.claim.requestDigest,
    runId,
    selectedTargetHandle: selected.handle
  });
  const secretRaw = {
    cleanup_state: "not_requested", descriptor_digest: descriptor,
    export_state: "not_requested", labels: Object.entries(secrets.labels).map(([name, value]) => ({ key: name, value })),
    operation: secretRequest.operation, operation_handle: secretReservation.claim.operationHandle,
    receipt_digest: `sha256:${"0".repeat(64)}`, request_digest: secretReservation.claim.requestDigest,
    result_handle: secrets.resultHandle, resulting_revision: 2, run_id: runId,
    selected_target: selectedTarget, version: "spawnfile.target-resource.receipt.v1"
  } as const;
  await journal.complete(secretReservation.claim, {
    ...secretRaw, receipt_digest: createTargetReceiptDigest(secretRaw)
  });

  const resource = async (kind: "data_network" | "evidence_volume", revision: number, index: number) => {
    const request = { ...envelope(revision, index), operation: kind === "data_network"
      ? "create_data_network" as const : "create_evidence_volume" as const };
    const reservation = await journal.reserve(request);
    if (reservation.kind !== "owner") throw new Error("expected resource owner");
    const spec = createDockerResourceSpec({
      kind, operationHandle: reservation.claim.operationHandle,
      requestDigest: reservation.claim.requestDigest, runId,
      selectedTargetHandle: selected.handle
    });
    const raw = {
      cleanup_state: "not_requested", descriptor_digest: descriptor,
      export_state: "not_requested", labels: Object.entries(spec.labels).map(([name, value]) => ({ key: name, value })),
      operation: request.operation, operation_handle: reservation.claim.operationHandle,
      receipt_digest: `sha256:${"0".repeat(64)}`, request_digest: reservation.claim.requestDigest,
      result_handle: spec.resultHandle, resulting_revision: revision + 1, run_id: runId,
      selected_target: selectedTarget, version: "spawnfile.target-resource.receipt.v1"
    } as const;
    await journal.complete(reservation.claim, { ...raw, receipt_digest: createTargetReceiptDigest(raw) });
    return spec;
  };
  const network = await resource("data_network", 2, 3);
  const evidence = await resource("evidence_volume", 3, 4);
  return {
    artifact: {
      ...artifactSpec,
      operationHandle: artifactReservation.claim.operationHandle,
      requestDigest: artifactReservation.claim.requestDigest
    },
    evidence, journal, network, secrets, selected
  };
};

interface FakeState {
  calls: string[][];
  container: { readonly id: string; status: "created" | "exited" | "running" } | null;
  createGate?: Deferred;
  createStarted?: Deferred;
  mutateContainer?: (projection: Record<string, unknown>) => Record<string, unknown>;
  mutateEvidence?: (projection: Record<string, unknown>) => Record<string, unknown>;
  mutateNetwork?: (projection: Record<string, unknown>) => Record<string, unknown>;
  mutateSecret?: (projection: Record<string, unknown>) => Record<string, unknown>;
  spec?: DockerWorldServiceSpec;
}

const valueAfter = (args: readonly string[], flag: string): string => {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${flag}`);
  return args[index + 1]!;
};
const mountsFor = (spec: DockerWorldServiceSpec) => spec.createArgs
  .filter((value, index, values) => values[index - 1] === "--mount")
  .map((value) => Object.fromEntries(value.split(",").map((part) => part.split("=", 2))))
  .map((mount) => ({
    Destination: mount.dst, Name: mount.src,
    RW: mount.dst === spec.evidenceMountPath, Type: "volume"
  }));
const containerProjection = (
  spec: DockerWorldServiceSpec,
  container: NonNullable<FakeState["container"]>
): Record<string, unknown> => ({
  AutoRemove: false, BindCount: 0, CapAddCount: 0, CapDrop: ["ALL"],
  CgroupnsMode: "private", DeviceCount: 0, DeviceRequestCount: 0, DnsCount: 0,
  Domainname: "", ExposedPortCount: 0, ExtraHostCount: 0, GroupAddCount: 0,
  Hostname: spec.containerName, Id: container.id, Image: spec.imageReference,
  IpcMode: "none", Labels: spec.receiptLabels, LinkCount: 0, LogType: "none",
  Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=1m,mode=1777" },
  Mounts: mountsFor(spec), Name: `/${spec.containerName}`,
  NetworkAttachmentCount: 1, NetworkAttachmentId: "b".repeat(64), NetworkAttachmentName: valueAfter(spec.createArgs, "--network"), NetworkAliases: spec.networkAlias ? [spec.networkAlias] : null,
  NetworkMode: valueAfter(spec.createArgs, "--network"), PidMode: "", PortBindingCount: 0,
  Privileged: false, PublishAllPorts: false, ReadonlyRootfs: true,
  RestartMaximumRetryCount: 0, RestartPolicyName: "no",
  SecurityOpt: ["no-new-privileges=true"], Status: container.status,
  UTSMode: "", UsernsMode: "", VolumesFromCount: 0
});

const executorFor = (seeded: Seeded, state: FakeState): DockerWorldServiceExecutor =>
  vi.fn(async (file, args) => {
    expect(file).toBe("docker"); state.calls.push([...args]);
    if (args[0] === "context") return { stderr: "", stdout: JSON.stringify(endpoint) };
    if (args[2] === "network" && args[3] === "inspect") {
      const base = { Internal: true, Labels: seeded.network.labels, Name: seeded.network.name };
      return { stderr: "", stdout: JSON.stringify([state.mutateNetwork?.(base) ?? base]) };
    }
    if (args[2] === "volume" && args[3] === "inspect") {
      if (args.at(-1) === seeded.evidence.name) {
        const base = { Labels: seeded.evidence.labels, Name: seeded.evidence.name };
        return { stderr: "", stdout: JSON.stringify([state.mutateEvidence?.(base) ?? base]) };
      }
      const base = { Driver: "local", Labels: seeded.secrets.labels,
        Name: seeded.secrets.volumeName, Options: null, Scope: "local" };
      return { stderr: "", stdout: JSON.stringify([state.mutateSecret?.(base) ?? base]) };
    }
    if (args[2] === "container" && args[3] === "inspect") {
      if (!state.container) throw new DockerWorldServiceProviderError("not_found");
      if (!state.spec) throw new Error("missing world spec");
      const base = containerProjection(state.spec, state.container);
      return { stderr: "", stdout: JSON.stringify([state.mutateContainer?.(base) ?? base]) };
    }
    if (args[2] === "container" && args[3] === "create") {
      state.createStarted?.release(); await state.createGate?.promise;
      if (state.container) throw new DockerWorldServiceProviderError("collision");
      state.container = { id: containerId, status: "created" };
      return { stderr: "", stdout: `${containerId}\n` };
    }
    if (args[2] === "container" && args[3] === "start" && state.container) {
      state.container = { ...state.container, status: "running" };
      return { stderr: "", stdout: `${containerId}\n` };
    }
    if (args[2] === "container" && args[3] === "stop" && state.container) {
      state.container = { ...state.container, status: "exited" };
      return { stderr: "", stdout: `${containerId}\n` };
    }
    if (args[2] === "container" && args[3] === "rm" && state.container) {
      state.container = null; return { stderr: "", stdout: `${containerId}\n` };
    }
    throw new Error(`unexpected command ${args.join(" ")}`);
  });

const setup = async (changes: Partial<FakeState> = {}, mutateResolution?: (
  resolution: WorldServiceResolution
) => unknown) => {
  const root = await temporaryRoot();
  const seeded = await seedJournal(root);
  const state: FakeState = { calls: [], container: null, ...changes };
  const resolver = {
    resolve: vi.fn(async ({ authorization }: { authorization: WorldServiceAuthorization }) => {
      state.spec = createDockerWorldServiceSpec({
        dataNetwork: {
          handle: seeded.network.resultHandle, labels: seeded.network.labels,
          name: seeded.network.name
        },
        evidenceMountPath: authorization.evidence_mount_path,
        evidenceVolume: {
          handle: seeded.evidence.resultHandle, labels: seeded.evidence.labels,
          name: seeded.evidence.name
        },
        imageDigest, imageReference,
        operationHandle: authorization.operation_handle,
        requestDigest: authorization.request_digest,
        runId,
        secretBindings: {
          handle: seeded.secrets.resultHandle, labels: seeded.secrets.labels,
          name: seeded.secrets.volumeName
        },
        selectedTargetHandle: seeded.selected.handle
      });
      const resolution: WorldServiceResolution = {
        artifact: {
          artifact_manifest_digest: manifest,
          identity_kind: "oci_image_manifest" as const,
          image_digest: imageDigest,
          image_reference: imageReference,
          operation_handle: seeded.artifact.operationHandle,
          request_digest: seeded.artifact.requestDigest,
          result_handle: seeded.artifact.resultHandle
        },
        authorization
      };
      return mutateResolution?.(resolution) ?? resolution;
    })
  };
  const executor = executorFor(seeded, state);
  const operations = createDockerWorldServiceOperations({
    authorityStore: await initializeWorldServiceAuthorityStore(path.join(root, "authority")),
    context, executor, journal: seeded.journal, resolver
  });
  const create = {
    data_network_handle: seeded.network.resultHandle, descriptor_digest: descriptor,
    evidence_mount_path: "/run/world/evidence",
    evidence_volume_handle: seeded.evidence.resultHandle, expected_revision: 4,
    idempotency_key: key(5), operation: "create_world_service" as const, run_id: runId,
    secret_bindings_handle: seeded.secrets.resultHandle,
    selected_target: { fingerprint: seeded.selected.fingerprint, handle: seeded.selected.handle },
    version: TARGET_RESOURCE_REQUEST_VERSION, world_artifact_handle: seeded.artifact.resultHandle
  };
  return { create, operations, resolver, seeded, state };
};

describe("Docker world-service lifecycle", () => {
  it("keeps prepared-image private identity out of world-service receipts", async () => {
    const privateConfig = `sha256:${"7".repeat(64)}`;
    const privateDaemon = `sha256:${"8".repeat(64)}`;
    const privateBase = `sha256:${"9".repeat(64)}`;
    const privateGc = `spfb_${"a".repeat(58)}`;
    const artifactOperation = "opaque_privateartifact01" as OpaqueTargetHandle;
    const artifactRequestDigest = `sha256:${"6".repeat(64)}`;
    const worldOperation = "opaque_privateworldop01" as OpaqueTargetHandle;
    const worldRequestDigest = `sha256:${"0".repeat(64)}`;
    const selectedHandle = "opaque_privatetarget001" as OpaqueTargetHandle;
    const artifact = createDockerConfigArtifactSpec({
      archiveDigest: `sha256:${"1".repeat(64)}`, artifactManifestDigest: manifest,
      baseImageConfigDigest: privateBase, buildPolicyDigest: `sha256:${"2".repeat(64)}`,
      bundleDigest: `sha256:${"3".repeat(64)}`, configId: privateConfig,
      daemonEpoch: privateDaemon, entrypoint: "runtime/runner.mjs",
      launcherDigest: `sha256:${"4".repeat(64)}`, networkAlias: "world",
      operationHandle: artifactOperation, requestDigest: artifactRequestDigest,
      selectedTargetHandle: selectedHandle,
      platform: { architecture: "amd64", os: "linux" },
      platformDigest: `sha256:${"5".repeat(64)}`
    });
    const request = parseTargetResourceRequest({
      data_network_handle: "opaque_privatenetwork01" as OpaqueTargetHandle,
      descriptor_digest: descriptor, evidence_mount_path: "/run/world/evidence",
      evidence_volume_handle: "opaque_privateevidence01" as OpaqueTargetHandle,
      expected_revision: 0, idempotency_key: "idem_privateworld0001",
      operation: "create_world_service" as const, run_id: "run-private-receipt",
      secret_bindings_handle: "opaque_privatesecbind01" as OpaqueTargetHandle,
      selected_target: { fingerprint: `sha256:${"f".repeat(32)}`, handle: selectedHandle },
      version: TARGET_RESOURCE_REQUEST_VERSION, world_artifact_handle: artifact.resultHandle
    });
    if (request.operation !== "create_world_service") throw new Error("create request expected");
    const network = createDockerResourceSpec({ kind: "data_network",
      operationHandle: "opaque_privatenetworkop1" as OpaqueTargetHandle,
      requestDigest: `sha256:${"a".repeat(64)}`, runId: request.run_id,
      selectedTargetHandle: selectedHandle });
    const evidence = createDockerResourceSpec({ kind: "evidence_volume",
      operationHandle: "opaque_privateevidenceop" as OpaqueTargetHandle,
      requestDigest: `sha256:${"b".repeat(64)}`, runId: request.run_id,
      selectedTargetHandle: selectedHandle });
    const secrets = createPreparedDockerSecretSpec({
      operationHandle: "opaque_privatesecretop01" as OpaqueTargetHandle,
      requestDigest: `sha256:${"c".repeat(64)}`, runId: request.run_id,
      selectedTargetHandle: selectedHandle
    });
    const authorization = createWorldServiceAuthorization({
      dataNetworkHandle: network.resultHandle, descriptorDigest: request.descriptor_digest,
      evidenceMountPath: request.evidence_mount_path, evidenceVolumeHandle: evidence.resultHandle,
      operationHandle: worldOperation, requestDigest: worldRequestDigest, runId: request.run_id,
      secretBindingsHandle: secrets.resultHandle, selectedTarget: request.selected_target,
      worldArtifactHandle: artifact.resultHandle
    });
    const resolution = parseWorldServiceResolution({ artifact: {
      archive_digest: `sha256:${"1".repeat(64)}`, artifact_manifest_digest: manifest,
      base_image_config_digest: privateBase, build_policy_digest: `sha256:${"2".repeat(64)}`,
      bundle_digest: `sha256:${"3".repeat(64)}`, config_id: privateConfig,
      daemon_epoch: privateDaemon, entrypoint: "runtime/runner.mjs", gc_tag: privateGc,
      identity_kind: "docker_image_config_digest", image_digest: privateConfig,
      image_reference: privateConfig, launcher_digest: `sha256:${"4".repeat(64)}`,
      network_alias: "world", operation_handle: artifactOperation,
      platform: { architecture: "amd64", os: "linux" },
      platform_digest: `sha256:${"5".repeat(64)}`,
      prepared_operation_handle: "opaque_privateprepareop1",
      prepared_request_digest: `sha256:${"6".repeat(64)}`,
      request_digest: artifactRequestDigest, result_handle: artifact.resultHandle
    }, authorization });
    const worldSpec = worldServiceSpecForBinding({ resolution, resources: {
      data_network: { handle: network.resultHandle, labels: network.labels, name: network.name },
      evidence_volume: { handle: evidence.resultHandle, labels: evidence.labels, name: evidence.name },
      secret_bindings: { handle: secrets.resultHandle, labels: secrets.labels, name: secrets.volumeName }
    } });
    const receipt = await createWorldServiceReceipt({
      claim: { operationHandle: worldOperation, requestDigest: worldRequestDigest } as never,
      journal: { read: async () => ({ revision: 0 }) } as never,
      labels: worldSpec.receiptLabels, request, resultHandle: worldSpec.resultHandle
    });
    const publicBytes = JSON.stringify(receipt);
    for (const privateValue of [privateConfig, privateDaemon, privateGc, privateBase]) {
      expect(publicBytes).not.toContain(privateValue);
    }
  });

  it("creates, byte-replays, starts, and stops one exact private sidecar", async () => {
    const fixture = await setup();
    const created = await fixture.operations.execute(fixture.create);
    const spec = fixture.state.spec!;
    expect(created.receipt.resulting_revision).toBe(5);
    expect(created.receiptBytes).toBe(JSON.stringify(created.receipt));
    const callsAfterCreate = fixture.state.calls.length;
    expect((await fixture.operations.execute(fixture.create)).receiptBytes).toBe(created.receiptBytes);
    expect(fixture.state.calls).toHaveLength(callsAfterCreate);

    const start = {
      descriptor_digest: descriptor, expected_revision: 5, idempotency_key: key(6),
      operation: "start_world_service" as const, run_id: runId,
      selected_target: fixture.create.selected_target, version: TARGET_RESOURCE_REQUEST_VERSION,
      world_service_handle: created.receipt.result_handle!
    };
    const started = await fixture.operations.execute(start);
    const stop = { ...start, expected_revision: 6, idempotency_key: key(7),
      operation: "stop_world_service" as const };
    const stopped = await fixture.operations.execute(stop);
    expect(started.receipt.result_handle).toBe(created.receipt.result_handle);
    expect(stopped.receipt.result_handle).toBeNull();
    expect((await fixture.seeded.journal.read()).revision).toBe(7);

    const mutations = fixture.state.calls.filter((args) => args[2] === "container"
      && ["create", "start", "stop", "rm"].includes(args[3]!));
    expect(mutations).toEqual([
      ["--context", context, ...spec.createArgs],
      ["--context", context, "container", "start", containerId],
      ["--context", context, "container", "stop", "--timeout", "10", containerId],
      ["--context", context, "container", "rm", containerId]
    ]);
    for (const forbidden of ["list", "ls", "ps", "logs", "port"]) {
      expect(fixture.state.calls.flat()).not.toContain(forbidden);
    }
    const publicBytes = `${created.receiptBytes}${started.receiptBytes}${stopped.receiptBytes}`;
    for (const privateValue of [containerId, spec.containerName, endpoint, imageDigest,
      imageReference, fixture.seeded.network.name, fixture.seeded.evidence.name,
      fixture.seeded.secrets.volumeName]) expect(publicBytes).not.toContain(privateValue);
  });

  it("rejects resolver authority drift before any Docker access", async () => {
    const fixture = await setup({}, (resolution) => ({
      ...resolution,
      authorization: { ...resolution.authorization, run_id: "run-authority-drift" }
    }));
    await expect(fixture.operations.execute(fixture.create))
      .rejects.toThrow("Docker world-service lifecycle failed");
    expect(fixture.state.calls).toEqual([]);
  });

  it("fails closed on resource and container drift before mutation", async () => {
    const fixtures = [
      await setup({ mutateNetwork: (value) => ({ ...value, Internal: false }) }),
      await setup({ mutateSecret: (value) => ({ ...value, Driver: "remote" }) }),
      await setup({ container: { id: containerId, status: "created" },
        mutateContainer: (value) => ({ ...value, PublishAllPorts: true }) })
    ];
    for (const fixture of fixtures) {
      await expect(fixture.operations.execute(fixture.create))
        .rejects.toThrow("Docker world-service lifecycle failed");
      expect(fixture.state.calls.some((args) => args[2] === "container"
        && ["create", "start", "stop", "rm"].includes(args[3]!))).toBe(false);
    }
  });

  it("joins an identical live create and rejects changed same-key bytes", async () => {
    const gate = deferred(); const started = deferred();
    const fixture = await setup({ createGate: gate, createStarted: started });
    const owner = fixture.operations.execute(fixture.create);
    await started.promise;
    const joined = fixture.operations.execute(fixture.create);
    const beforeChanged = fixture.state.calls.length;
    await expect(fixture.operations.execute({
      ...fixture.create, descriptor_digest: `sha256:${"0".repeat(64)}`
    })).rejects.toThrow("Docker world-service lifecycle failed");
    expect(fixture.state.calls).toHaveLength(beforeChanged);
    gate.release();
    const [left, right] = await Promise.all([owner, joined]);
    expect(left.receiptBytes).toBe(right.receiptBytes);
    expect(fixture.state.calls.filter((args) => args[2] === "container"
      && args[3] === "create")).toHaveLength(1);
  });
});
