import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { EVIDENCE_EXPORT_MOUNT, EVIDENCE_EXPORT_HELPER_CMD, EVIDENCE_EXPORT_HELPER_CONTRACT, EVIDENCE_EXPORT_HELPER_CONTRACT_LABEL, EVIDENCE_EXPORT_HELPER_ENTRYPOINT, EVIDENCE_EXPORT_HELPER_ENV, EVIDENCE_EXPORT_HELPER_USER, createEvidenceExportHelper, createEvidenceExportHelperSpec, parseEvidenceVolumeAuthority } from "./evidenceExportProvider.js";
import { createDockerArtifactSpec, initializeDockerArtifactIdentityStore } from "./dockerArtifactsProvider.js";
import { initializeEvidenceExportAuthorityStore, type EvidenceExportAdmission, type EvidenceExportAuthorityStoreOptions } from "./evidenceExportStore.js";
import { createDockerResourceSpec } from "./dockerResourcesProvider.js";
import { createEvidenceExportOperations } from "./evidenceExport.js";
import { initializeTargetJournal, type TargetJournalStore } from "./journal.js";
import { selectTarget } from "./dockerTarget.js";
import { createTargetReceiptDigest } from "./handles.js";
import { parseOpaqueTargetHandle, TARGET_RESOURCE_REQUEST_VERSION } from "./contracts.js";

const roots: string[] = [];
export const root = async (): Promise<string> => {
  const value = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-export-")));
  roots.push(value);
  return value;
};
export const cleanupTestRoots = async (): Promise<void> => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true })));
};
const admission = (): EvidenceExportAdmission => {
  const selectedTargetHandle = parseOpaqueTargetHandle("opaque_dddddddddddddddd");
  const volume = createDockerResourceSpec({ kind: "evidence_volume", operationHandle: parseOpaqueTargetHandle("opaque_eeeeeeeeeeeeeeee"), requestDigest: `sha256:${"f".repeat(64)}`, runId: "run-one", selectedTargetHandle });
  return ({
    descriptor_digest: `sha256:${"a".repeat(64)}`,
    evidence_volume: parseEvidenceVolumeAuthority({ labels: volume.labels, name: volume.name, resultHandle: volume.resultHandle }),
    helper: createEvidenceExportHelper({
      artifactManifestDigest: `sha256:${"b".repeat(64)}`,
      imageDigest: `sha256:${"c".repeat(64)}`,
      imageReference: `registry.example/export@sha256:${"c".repeat(64)}`,
      resultHandle: parseOpaqueTargetHandle("opaque_bbbbbbbbbbbbbbbb")
    }),
    helper_contract: EVIDENCE_EXPORT_HELPER_CONTRACT,
    operation_handle: parseOpaqueTargetHandle("opaque_cccccccccccccccc"),
    request_digest: `sha256:${"d".repeat(64)}`,
    run_id: "run-one",
    selected_target: { fingerprint: `sha256:${"e".repeat(32)}`, handle: selectedTargetHandle },
    version: "spawnfile.target-evidence-export.private.v1"
  });
};
export { admission };

const complete = async (journal: TargetJournalStore, claim: { operationHandle: string; requestDigest: string }, request: Record<string, unknown>, spec: { labels: Record<string, string>; resultHandle: string }) => {
  const raw = { cleanup_state: "not_requested", descriptor_digest: request.descriptor_digest, export_state: "not_requested", labels: Object.entries(spec.labels).map(([key, value]) => ({ key, value })), operation: request.operation, operation_handle: claim.operationHandle, receipt_digest: `sha256:${"0".repeat(64)}`, request_digest: claim.requestDigest, result_handle: spec.resultHandle, resulting_revision: (await journal.read()).revision + 1, run_id: request.run_id, selected_target: request.selected_target, version: "spawnfile.target-resource.receipt.v1" } as const;
  await journal.complete(claim as never, { ...raw, receipt_digest: createTargetReceiptDigest(raw) });
};
export { complete };

const octalField = (value: number, length: number): string => {
  const raw = value.toString(8);
  if (raw.length > length - 1) throw new Error("field overflow");
  return `${raw.padStart(length - 1, "0")}\0`;
};
export const header = (name: string, data: Uint8Array): Buffer => {
  const out = Buffer.alloc(512);
  out.write(name);
  out.write(octalField(0o644, 8), 100);
  out.write(octalField(0, 8), 108);
  out.write(octalField(0, 8), 116);
  out.write(octalField(data.byteLength, 12), 124);
  out.write(octalField(0, 12), 136);
  out.fill(32, 148, 156);
  out.write("0", 156);
  out.write("ustar\0", 257);
  out.write("00", 263);
  out.write(octalField(0, 8), 329);
  out.write(octalField(0, 8), 337);
  const checksum = out.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, "0");
  if (checksum.length > 6) throw new Error("checksum overflow");
  out.write(`${checksum}\0 `, 148);
  return out;
};

export interface LifecycleExportFixture {
  readonly calls: string[][];
  readonly directory: string;
  readonly execute: (destination?: string) => Promise<unknown>;
  readonly executeDistinct: (destination?: string) => Promise<unknown>;
  readonly executeReplayWithBlockedExecutors: (destination?: string) => Promise<{ readonly dockerCalls: number; readonly exportCalls: number; readonly result: unknown }>;
  readonly rejectReplayWithWrongHelperRequest: (destination?: string) => Promise<{ readonly dockerCalls: number; readonly error: unknown; readonly exportCalls: number }>;
  readonly recover: (destination?: string) => Promise<unknown>;
  readonly recoverDistinct: (destination?: string) => Promise<unknown>;
  readonly recoverPeer: (destination?: string) => Promise<unknown>;
  readonly seedStaleExportClaim: () => Promise<void>;
  readonly setHelperInspectionDrift: (value: boolean) => void;
  readonly setVolumeInspectionDrift: (value: boolean) => void;
  readonly getContainerName: () => string | undefined;
  readonly getExportCalls: () => number;
  readonly getRemoveCalls: () => number;
  readonly getRemoveArgs: () => string[][];
  readonly getExportStorePath: () => string;
  readonly readJournalRevision: () => Promise<number>;
}
export interface LifecycleExportInput {
  readonly createShouldFail?: boolean;
  readonly createDestinationStoreOptions?: EvidenceExportAuthorityStoreOptions;
  readonly foreignInspect?: "projection" | "transport" | false;
  readonly startShouldFail?: boolean;
  readonly cleanupShouldFail?: boolean;
  readonly boundaryFailures?: {
    readonly beforeBindAdmission?: () => Promise<void> | void;
    readonly beforeBindDestination?: () => Promise<void> | void;
    readonly beforeIndexLoad?: () => Promise<void> | void;
    readonly beforeIndexBind?: () => Promise<void> | void;
    readonly beforeArchive?: () => Promise<void> | void;
    readonly beforePublishTempWrite?: () => Promise<void> | void;
    readonly beforePublishTempOpen?: (temporary: string) => Promise<void> | void;
    readonly beforePublishTempSync?: () => Promise<void> | void;
    readonly beforePublishFinalLink?: () => Promise<void> | void;
    readonly beforePublishDirectorySync?: () => Promise<void> | void;
    readonly beforeJournalComplete?: () => Promise<void> | void;
    readonly beforeRequireDestination?: () => Promise<void> | void;
  };
  readonly onLoadIndex?: () => Promise<void> | void;
  readonly payload?: Uint8Array;
}

export const runLifecycleExport = async (input: LifecycleExportInput = {}): Promise<LifecycleExportFixture> => {
  const directory = await root();
  const context = "test_context";
  const calls: string[][] = [];
  const descriptor = `sha256:${"a".repeat(64)}`;
  const manifest = `sha256:${"b".repeat(64)}`;
  const image = `sha256:${"c".repeat(64)}`;
  const reference = `registry.example/export@${image}`;
  const payload = input.payload ?? new Uint8Array([...header("ball", Buffer.from("kick")), ...Buffer.from("kick"), ...Buffer.alloc(508), ...Buffer.alloc(1024)]);
  let volume: ReturnType<typeof createDockerResourceSpec>;
  let created: string[] = [];
  let exportCalls = 0;
  let removeCalls = 0;
  let helperInspectionDrift = false;
  let volumeInspectionDrift = false;

  const projection = JSON.stringify([{
    RepoDigests: [reference],
    Config: {
      Entrypoint: EVIDENCE_EXPORT_HELPER_ENTRYPOINT,
      Cmd: EVIDENCE_EXPORT_HELPER_CMD,
      Labels: { [EVIDENCE_EXPORT_HELPER_CONTRACT_LABEL]: "v1" },
        Env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
      ExposedPorts: null,
      Healthcheck: null,
      User: EVIDENCE_EXPORT_HELPER_USER,
      Volumes: null
    }
  }]);
  const imageLabels = { [EVIDENCE_EXPORT_HELPER_CONTRACT_LABEL]: "v1" } as const;
  const containerProjectionLabels = { ...imageLabels };
  const removeCallArgs: string[][] = [];
  const executor = async (_file: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "context") return { stderr: "", stdout: JSON.stringify("unix:///private/test.sock") };
    if (args[2] === "volume" && args[3] === "inspect") return { stderr: "", stdout: JSON.stringify([{ Labels: volumeInspectionDrift ? { ...volume!.labels, "spawnfile.target.drift": "true" } : volume!.labels, Name: volume!.name }]) };
    if (args[2] === "image" && args[3] === "inspect") return { stderr: "", stdout: helperInspectionDrift ? projection.replace("65534:65534", "0:0") : projection };
    if (args[2] === "container" && args[3] === "create") {
      created = args;
      if (input.createShouldFail) throw new Error("create transport failed");
      return { stderr: "", stdout: "container" };
    }
    if (args[2] === "container" && args[3] === "inspect") {
      if (input.foreignInspect === "transport") throw new Error("inspect transport failed");
      return {
        stderr: "",
        stdout: helperProjection(created, volume!.name, containerProjectionLabels,
          input.foreignInspect === "projection"
            ? (projection) => { projection.Config = { ...projection.Config, User: "0:0" }; }
            : undefined)
      };
    }
    if (args[2] === "container" && args[3] === "rm") {
      removeCallArgs.push(args);
      removeCalls += 1;
      if (input.cleanupShouldFail) throw new Error("rm failed");
      return { stderr: "", stdout: "removed" };
    }
    throw new Error(`unexpected docker invocation: ${args.join(" ")}`);
  };

  const selected = await selectTarget({ context, execFile: executor });
  const journal = await initializeTargetJournal({ context, descriptorDigest: descriptor, root: path.join(directory, "journal"), runId: "run-one", selectedTarget: selected });
  const envelope = (expected_revision: number, idempotency_key: string) => ({ descriptor_digest: descriptor, expected_revision, idempotency_key, run_id: "run-one", selected_target: { fingerprint: selected.fingerprint, handle: selected.handle }, version: TARGET_RESOURCE_REQUEST_VERSION });
  const artifactRequest = { ...envelope(0, "idem_aaaaaaaaaaaaaaaa"), artifact_manifest_digest: manifest, operation: "resolve_world_artifact" as const };
  const artifactClaim = await journal.reserve(artifactRequest);
  if (artifactClaim.kind !== "owner") throw new Error("artifact reservation failed");
  const artifact = createDockerArtifactSpec({ artifactManifestDigest: manifest, imageDigest: image, imageReference: reference, operationHandle: artifactClaim.claim.operationHandle, requestDigest: artifactClaim.claim.requestDigest, selectedTargetHandle: selected.handle });
  await complete(journal, artifactClaim.claim, artifactRequest, artifact);

  const identities = await initializeDockerArtifactIdentityStore(path.join(directory, "identities"));
  await identities.bind({ artifactManifestDigest: manifest, imageDigest: image, imageReference: reference, operationHandle: artifactClaim.claim.operationHandle, requestDigest: artifactClaim.claim.requestDigest, resultHandle: artifact.resultHandle, selectedTargetHandle: selected.handle });

  const volumeRequest = { ...envelope(1, "idem_bbbbbbbbbbbbbbbb"), operation: "create_evidence_volume" as const };
  const volumeClaim = await journal.reserve(volumeRequest);
  if (volumeClaim.kind !== "owner") throw new Error("volume reservation failed");
  volume = createDockerResourceSpec({ kind: "evidence_volume", operationHandle: volumeClaim.claim.operationHandle, requestDigest: volumeClaim.claim.requestDigest, runId: "run-one", selectedTargetHandle: selected.handle });
  await complete(journal, volumeClaim.claim, volumeRequest, volume);

  const exportRequest = { ...envelope(2, "idem_cccccccccccccccc"), evidence_volume_handle: volume.resultHandle, operation: "export_evidence_volume" as const };
  const destination = path.join(directory, "match.tar");
  const authorityStore = await initializeEvidenceExportAuthorityStore(path.join(directory, "export-store"), input.createDestinationStoreOptions);
  const observedAuthorityStore = input.onLoadIndex ? {
    bindAdmission: authorityStore.bindAdmission.bind(authorityStore),
    bindDestination: authorityStore.bindDestination.bind(authorityStore),
    bindIndex: authorityStore.bindIndex.bind(authorityStore),
    claimExport: authorityStore.claimExport.bind(authorityStore),
    clearStaleExportClaim: authorityStore.clearStaleExportClaim.bind(authorityStore),
    loadAdmission: authorityStore.loadAdmission.bind(authorityStore),
    loadIndex: async (value: EvidenceExportAdmission) => {
      await input.onLoadIndex!();
      return authorityStore.loadIndex(value);
    },
    releaseExport: authorityStore.releaseExport.bind(authorityStore),
    requireDestination: authorityStore.requireDestination.bind(authorityStore)
  } : authorityStore;
  const operationOptions = {
    authorityStore: observedAuthorityStore,
    artifactIdentityStore: identities,
    context,
    executor,
    exportExecutor: async () => {
      exportCalls += 1;
      if (input.startShouldFail) throw new Error("start failed");
      return { bytes: payload };
    },
    helperArtifactBundle: { operation_handle: artifactClaim.claim.operationHandle, request_digest: artifactClaim.claim.requestDigest, result_handle: artifact.resultHandle },
    helperArtifactManifestDigest: manifest,
    helperArtifactContract: EVIDENCE_EXPORT_HELPER_CONTRACT,
    journal,
    testHooks: {
      beforeBindAdmission: input.boundaryFailures?.beforeBindAdmission,
      beforeBindDestination: input.boundaryFailures?.beforeBindDestination,
      beforeIndexLoad: input.boundaryFailures?.beforeIndexLoad,
      beforeIndexBind: input.boundaryFailures?.beforeIndexBind,
      beforeArchive: input.boundaryFailures?.beforeArchive,
      beforePublishTempWrite: input.boundaryFailures?.beforePublishTempWrite,
      beforePublishTempOpen: input.boundaryFailures?.beforePublishTempOpen,
      beforePublishTempSync: input.boundaryFailures?.beforePublishTempSync,
      beforePublishFinalLink: input.boundaryFailures?.beforePublishFinalLink,
      beforePublishDirectorySync: input.boundaryFailures?.beforePublishDirectorySync,
      beforeJournalComplete: input.boundaryFailures?.beforeJournalComplete,
      beforeRequireDestination: input.boundaryFailures?.beforeRequireDestination
    }
  };
  const operations = createEvidenceExportOperations(operationOptions);

  const execute = async (destinationValue?: string) => operations.execute(exportRequest, destinationValue ?? destination);
  const executeDistinct = async (destinationValue?: string) => operations.execute({ ...exportRequest, evidence_volume_handle: artifact.resultHandle }, destinationValue ?? destination);
  const executeReplayWithBlockedExecutors = async (destinationValue?: string) => {
    let dockerCalls = 0;
    let blockedExportCalls = 0;
    const replay = createEvidenceExportOperations({
      ...operationOptions,
      executor: async () => { dockerCalls += 1; throw new Error("completed replay touched Docker"); },
      exportExecutor: async () => { blockedExportCalls += 1; throw new Error("completed replay exported evidence"); }
    });
    const result = await replay.execute(exportRequest, destinationValue ?? destination);
    return { dockerCalls, exportCalls: blockedExportCalls, result };
  };
  const rejectReplayWithWrongHelperRequest = async (destinationValue?: string) => {
    let dockerCalls = 0;
    let blockedExportCalls = 0;
    const replay = createEvidenceExportOperations({
      ...operationOptions,
      executor: async () => { dockerCalls += 1; throw new Error("completed replay touched Docker"); },
      exportExecutor: async () => { blockedExportCalls += 1; throw new Error("completed replay exported evidence"); },
      helperArtifactBundle: { ...operationOptions.helperArtifactBundle, request_digest: `sha256:${"f".repeat(64)}` }
    });
    let error: unknown;
    try { await replay.execute(exportRequest, destinationValue ?? destination); } catch (caught) { error = caught; }
    return { dockerCalls, error, exportCalls: blockedExportCalls };
  };
  const pendingExport = async () => {
    const entry = (await journal.read()).entries.find((value) => value.operation === "export_evidence_volume" && value.state === "pending");
    if (!entry) throw new Error("pending export missing");
    return entry;
  };
  const recoveryRequest = async (distinct = false) => {
    const entry = await pendingExport();
    return { ...envelope((await journal.read()).revision, distinct ? "idem_eeeeeeeeeeeeeeee" : "idem_dddddddddddddddd"), operation: "recover_operation" as const, operation_handle: entry.operation_handle };
  };
  const recover = async (destinationValue?: string) => operations.recover(await recoveryRequest(), destinationValue ?? destination);
  const recoverDistinct = async (destinationValue?: string) => operations.recover(await recoveryRequest(true), destinationValue ?? destination);
  const recoverPeer = async (destinationValue?: string) => createEvidenceExportOperations(operationOptions).recover(await recoveryRequest(), destinationValue ?? destination);
  const seedStaleExportClaim = async (): Promise<void> => {
    const entry = await pendingExport(); const admission = await authorityStore.loadAdmission(entry.operation_handle); if (await authorityStore.claimExport(admission) === null) throw new Error("export claim unavailable");
  };
  const getContainerName = () => {
    const create = calls.find((args) => args[2] === "container" && args[3] === "create");
    if (!create) return undefined;
    const name = create[create.indexOf("--name") + 1];
    return typeof name === "string" ? name : undefined;
  };

  return { calls, directory, execute, executeDistinct, executeReplayWithBlockedExecutors, rejectReplayWithWrongHelperRequest, recover, recoverDistinct, recoverPeer, seedStaleExportClaim, setHelperInspectionDrift: (value) => { helperInspectionDrift = value; }, setVolumeInspectionDrift: (value) => { volumeInspectionDrift = value; }, getContainerName, getExportCalls: () => exportCalls, getRemoveCalls: () => removeCalls, getRemoveArgs: () => [...removeCallArgs], getExportStorePath: () => path.join(directory, "export-store"), readJournalRevision: async () => (await journal.read()).revision };
};

export const helperProjection = (args: string[], volumeName: string, imageLabels: Record<string, string>, mutate?: (value: { Config: { Entrypoint: unknown; Cmd: unknown; Env: unknown; ExposedPorts: unknown; Healthcheck: unknown; Image: unknown; Labels: Record<string, string>; User: unknown; Volumes: unknown }; HostConfig: Record<string, unknown>; Mounts: Array<{ Type: string; Name: string; Destination: string; RW: boolean }> }) => void): string => {
  const image = args[args.length - 1]!;
  const containerName = args[args.indexOf("--name") + 1]!;
  const labels = Object.fromEntries(args.filter((_, index) => args[index - 1] === "--label").map((value) => value.split("=", 2)));
  const projection = {
    Name: `/${containerName}`,
    Config: {
      Entrypoint: EVIDENCE_EXPORT_HELPER_ENTRYPOINT,
      Cmd: EVIDENCE_EXPORT_HELPER_CMD,
      Env: EVIDENCE_EXPORT_HELPER_ENV,
      ExposedPorts: null,
      Healthcheck: null,
      Image: image,
      Labels: { ...imageLabels, ...labels },
      User: EVIDENCE_EXPORT_HELPER_USER,
      Volumes: null
    },
    HostConfig: {
      AutoRemove: false,
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Privileged: false,
      CapAdd: null,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges=true"],
      PidsLimit: 64,
      Memory: 134217728,
      NanoCpus: 250000000,
      IpcMode: "none",
      PidMode: "",
      UTSMode: "",
      UsernsMode: "",
      CgroupnsMode: "private",
      Binds: null,
      VolumesFrom: null,
      ExtraHosts: null,
      Dns: null,
      Links: null,
      GroupAdd: null,
      Devices: null,
      DeviceRequests: null,
      PortBindings: null,
      PublishAllPorts: false,
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      LogConfig: { Type: "none", Config: {} }
    },
    Mounts: [{ Type: "volume", Name: volumeName, Destination: EVIDENCE_EXPORT_MOUNT, RW: false }]
  };
  mutate?.(projection);
  return JSON.stringify([projection]);
};
