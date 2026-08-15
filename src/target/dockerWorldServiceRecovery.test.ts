import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TARGET_RESOURCE_REQUEST_VERSION,
  type OpaqueTargetHandle,
  type SelectedTargetReceipt
} from "./contracts.js";
import { createDockerArtifactSpec } from "./dockerArtifactsProvider.js";
import { createDockerResourceSpec, type DockerResourceSpec } from "./dockerResourcesProvider.js";
import { createPreparedDockerSecretSpec, type DockerSecretSpec } from "./dockerSecretsProvider.js";
import { selectTarget } from "./dockerTarget.js";
import { createDockerWorldServiceOperations } from "./dockerWorldService.js";
import {
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
const runId = "run-world-recovery";
const descriptor = `sha256:${"d".repeat(64)}`;
const manifest = `sha256:${"a".repeat(64)}`;
const imageDigest = `sha256:${"b".repeat(64)}`;
const imageReference = `registry.example/sim/world@${imageDigest}`;
const containerId = "c".repeat(64);
const roots: string[] = [];
const key = (index: number): string => `idem_${String(index).padStart(16, "a")}`;
const root = async (): Promise<string> => {
  const value = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-world-recovery-")));
  roots.push(value); return value;
};
afterEach(async () => Promise.all(roots.splice(0).map((value) => rm(value, {
  force: true, maxRetries: 3, recursive: true, retryDelay: 10
}))));

interface Seeded {
  readonly artifact: ReturnType<typeof createDockerArtifactSpec> & {
    readonly operationHandle: OpaqueTargetHandle;
    readonly requestDigest: string;
  };
  readonly evidence: DockerResourceSpec;
  readonly journalRoot: string;
  readonly network: DockerResourceSpec;
  readonly secrets: DockerSecretSpec;
  readonly selected: SelectedTargetReceipt;
}

const receipt = (input: {
  readonly claim: { readonly operationHandle: OpaqueTargetHandle; readonly requestDigest: string };
  readonly labels: Readonly<Record<string, string>>;
  readonly operation: "resolve_world_artifact" | "prepare_secret_bindings"
    | "create_data_network" | "create_evidence_volume";
  readonly resultHandle: OpaqueTargetHandle;
  readonly revision: number;
  readonly selected: SelectedTargetReceipt;
}) => {
  const raw = {
    cleanup_state: "not_requested", descriptor_digest: descriptor,
    export_state: "not_requested",
    labels: Object.entries(input.labels).map(([key, value]) => ({ key, value })),
    operation: input.operation, operation_handle: input.claim.operationHandle,
    receipt_digest: `sha256:${"0".repeat(64)}`, request_digest: input.claim.requestDigest,
    result_handle: input.resultHandle, resulting_revision: input.revision, run_id: runId,
    selected_target: { fingerprint: input.selected.fingerprint, handle: input.selected.handle },
    version: "spawnfile.target-resource.receipt.v1"
  } as const;
  return { ...raw, receipt_digest: createTargetReceiptDigest(raw) };
};

const seed = async (base: string): Promise<Seeded> => {
  const selected = await selectTarget({ context,
    execFile: async () => ({ stderr: "", stdout: JSON.stringify(endpoint) }) });
  const journalRoot = path.join(base, "journal");
  const journal = await initializeTargetJournal({
    context, descriptorDigest: descriptor, root: journalRoot, runId, selectedTarget: selected
  });
  const selectedTarget = { fingerprint: selected.fingerprint, handle: selected.handle };
  const envelope = (revision: number, index: number) => ({
    descriptor_digest: descriptor, expected_revision: revision, idempotency_key: key(index),
    run_id: runId, selected_target: selectedTarget, version: TARGET_RESOURCE_REQUEST_VERSION
  });

  const artifactRequest = { ...envelope(0, 1), artifact_manifest_digest: manifest,
    operation: "resolve_world_artifact" as const };
  const artifactClaim = await journal.reserve(artifactRequest);
  if (artifactClaim.kind !== "owner") throw new Error("expected artifact owner");
  const artifactSpec = createDockerArtifactSpec({
    artifactManifestDigest: manifest, imageDigest, imageReference,
    operationHandle: artifactClaim.claim.operationHandle,
    requestDigest: artifactClaim.claim.requestDigest, selectedTargetHandle: selected.handle
  });
  await journal.complete(artifactClaim.claim, receipt({ claim: artifactClaim.claim,
    labels: artifactSpec.labels, operation: artifactRequest.operation,
    resultHandle: artifactSpec.resultHandle, revision: 1, selected }));

  const secretRequest = { ...envelope(1, 2), bindings: [{ name: "world", scope: "runtime",
    source_handle: "opaque_sourcehandle0001" as OpaqueTargetHandle }],
    operation: "prepare_secret_bindings" as const };
  const secretClaim = await journal.reserve(secretRequest);
  if (secretClaim.kind !== "owner") throw new Error("expected secret owner");
  const secrets = createPreparedDockerSecretSpec({
    operationHandle: secretClaim.claim.operationHandle,
    requestDigest: secretClaim.claim.requestDigest, runId, selectedTargetHandle: selected.handle
  });
  await journal.complete(secretClaim.claim, receipt({ claim: secretClaim.claim,
    labels: secrets.labels, operation: secretRequest.operation,
    resultHandle: secrets.resultHandle, revision: 2, selected }));

  const resource = async (kind: "data_network" | "evidence_volume", revision: number, index: number) => {
    const request = { ...envelope(revision, index), operation: kind === "data_network"
      ? "create_data_network" as const : "create_evidence_volume" as const };
    const reservation = await journal.reserve(request);
    if (reservation.kind !== "owner") throw new Error("expected resource owner");
    const spec = createDockerResourceSpec({ kind,
      operationHandle: reservation.claim.operationHandle,
      requestDigest: reservation.claim.requestDigest, runId,
      selectedTargetHandle: selected.handle });
    await journal.complete(reservation.claim, receipt({ claim: reservation.claim,
      labels: spec.labels, operation: request.operation,
      resultHandle: spec.resultHandle, revision: revision + 1, selected }));
    return spec;
  };
  const network = await resource("data_network", 2, 3);
  const evidence = await resource("evidence_volume", 3, 4);
  return { artifact: { ...artifactSpec, operationHandle: artifactClaim.claim.operationHandle,
    requestDigest: artifactClaim.claim.requestDigest }, evidence, journalRoot, network, secrets, selected };
};

type Mutation = "create" | "start" | "stop" | "rm";
interface State {
  calls: string[][];
  container: { readonly id: string; status: "created" | "exited" | "running" } | null;
  crashAfter?: Mutation;
  crashNextInspect: boolean;
  failBefore?: Mutation;
  spec?: DockerWorldServiceSpec;
}
const after = (args: readonly string[], flag: string): string => {
  const index = args.indexOf(flag); const value = args[index + 1];
  if (index < 0 || !value) throw new Error(`missing ${flag}`); return value;
};
const projection = (spec: DockerWorldServiceSpec, current: NonNullable<State["container"]>) => {
  const mounts = spec.createArgs.filter((value, index, values) => values[index - 1] === "--mount")
    .map((value) => Object.fromEntries(value.split(",").map((part) => part.split("=", 2))))
    .map((mount) => ({ Destination: mount.dst, Name: mount.src,
      RW: mount.dst === spec.evidenceMountPath, Type: "volume" }));
  return {
    AutoRemove: false, BindCount: 0, CapAddCount: 0, CapDrop: ["ALL"],
    CgroupnsMode: "private", DeviceCount: 0, DeviceRequestCount: 0, DnsCount: 0,
    Domainname: "", ExposedPortCount: 0, ExtraHostCount: 0, GroupAddCount: 0,
    Hostname: spec.containerName, Id: current.id, Image: spec.imageReference, IpcMode: "none",
    Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=1m,mode=1777" },
    Labels: spec.receiptLabels, LinkCount: 0, LogType: "none", Mounts: mounts,
    Name: `/${spec.containerName}`, NetworkAttachmentCount: 1, NetworkAttachmentId: "b".repeat(64),
    NetworkAttachmentName: after(spec.createArgs, "--network"),
    NetworkAliases: spec.networkAlias ? [spec.networkAlias] : null,
    NetworkMode: after(spec.createArgs, "--network"), PidMode: "", PortBindingCount: 0,
    Privileged: false, PublishAllPorts: false, ReadonlyRootfs: true,
    RestartMaximumRetryCount: 0, RestartPolicyName: "no",
    SecurityOpt: ["no-new-privileges=true"], Status: current.status,
    UTSMode: "", UsernsMode: "", VolumesFromCount: 0
  };
};

const fake = (seeded: Seeded, state: State): DockerWorldServiceExecutor =>
  vi.fn(async (_file, args) => {
    state.calls.push([...args]);
    if (args[0] === "context") return { stderr: "", stdout: JSON.stringify(endpoint) };
    if (args[2] === "network" && args[3] === "inspect") return { stderr: "",
      stdout: JSON.stringify([{ Internal: true, Labels: seeded.network.labels, Name: seeded.network.name }]) };
    if (args[2] === "volume" && args[3] === "inspect") {
      if (args.at(-1) === seeded.evidence.name) return { stderr: "",
        stdout: JSON.stringify([{ Labels: seeded.evidence.labels, Name: seeded.evidence.name }]) };
      return { stderr: "", stdout: JSON.stringify([{ Driver: "local", Labels: seeded.secrets.labels,
        Name: seeded.secrets.volumeName, Options: null, Scope: "local" }]) };
    }
    if (args[2] === "container" && args[3] === "inspect") {
      if (state.crashNextInspect) { state.crashNextInspect = false; throw new Error("private crash"); }
      if (!state.container) throw new DockerWorldServiceProviderError("not_found");
      if (!state.spec) throw new Error("missing spec");
      return { stderr: "", stdout: JSON.stringify([projection(state.spec, state.container)]) };
    }
    const mutation = args[2] === "container" && ["create", "start", "stop", "rm"].includes(args[3]!)
      ? args[3] as Mutation : null;
    if (mutation) {
      if (state.failBefore === mutation) { state.failBefore = undefined; throw new Error("private failure"); }
      if (mutation === "create") {
        if (state.container) throw new DockerWorldServiceProviderError("collision");
        state.container = { id: containerId, status: "created" };
      } else if (mutation === "start" && state.container) {
        state.container = { ...state.container, status: "running" };
      } else if (mutation === "stop" && state.container) {
        state.container = { ...state.container, status: "exited" };
      } else if (mutation === "rm" && state.container) state.container = null;
      else throw new Error("invalid fake mutation");
      if (state.crashAfter === mutation) { state.crashAfter = undefined; state.crashNextInspect = true; }
      return { stderr: "", stdout: mutation === "create" ? `${containerId}\n` : "" };
    }
    throw new Error(`unexpected Docker command ${args.join(" ")}`);
  });

const setup = async () => {
  const base = await root(); const seeded = await seed(base);
  const authorityRoot = path.join(base, "authority");
  const state: State = { calls: [], container: null, crashNextInspect: false };
  const openJournal = () => initializeTargetJournal({
    context, descriptorDigest: descriptor, root: seeded.journalRoot, runId,
    selectedTarget: seeded.selected
  });
  const resolver = { resolve: async ({ authorization }: { authorization: WorldServiceAuthorization }) => {
    state.spec = createDockerWorldServiceSpec({
      dataNetwork: { handle: seeded.network.resultHandle, labels: seeded.network.labels,
        name: seeded.network.name },
      evidenceMountPath: authorization.evidence_mount_path,
      evidenceVolume: { handle: seeded.evidence.resultHandle, labels: seeded.evidence.labels,
        name: seeded.evidence.name },
      imageDigest, imageReference, operationHandle: authorization.operation_handle,
      requestDigest: authorization.request_digest, runId,
      secretBindings: { handle: seeded.secrets.resultHandle, labels: seeded.secrets.labels,
        name: seeded.secrets.volumeName }, selectedTargetHandle: seeded.selected.handle
    });
    return { artifact: {
      artifact_manifest_digest: manifest, image_digest: imageDigest, image_reference: imageReference,
      operation_handle: seeded.artifact.operationHandle,
      request_digest: seeded.artifact.requestDigest, result_handle: seeded.artifact.resultHandle
    }, authorization } as WorldServiceResolution;
  } };
  const operations = async (journal?: TargetJournalStore) => createDockerWorldServiceOperations({
    authorityStore: await initializeWorldServiceAuthorityStore(authorityRoot), context,
    executor: fake(seeded, state), journal: journal ?? await openJournal(), resolver
  });
  const selectedTarget = { fingerprint: seeded.selected.fingerprint, handle: seeded.selected.handle };
  const create = {
    data_network_handle: seeded.network.resultHandle, descriptor_digest: descriptor,
    evidence_mount_path: "/run/world/evidence",
    evidence_volume_handle: seeded.evidence.resultHandle, expected_revision: 4,
    idempotency_key: key(5), operation: "create_world_service" as const, run_id: runId,
    secret_bindings_handle: seeded.secrets.resultHandle, selected_target: selectedTarget,
    version: TARGET_RESOURCE_REQUEST_VERSION, world_artifact_handle: seeded.artifact.resultHandle
  };
  const startFor = (handle: OpaqueTargetHandle) => ({
    descriptor_digest: descriptor, expected_revision: 5, idempotency_key: key(6),
    operation: "start_world_service" as const, run_id: runId, selected_target: selectedTarget,
    version: TARGET_RESOURCE_REQUEST_VERSION, world_service_handle: handle
  });
  return { create, openJournal, operations, startFor, state };
};

const mutationCount = (state: State, operation: Mutation): number => state.calls.filter((args) =>
  args[2] === "container" && args[3] === operation).length;

describe("Docker world-service recovery", () => {
  it("recovers create before mutation, after mutation, and after a completion crash", async () => {
    const before = await setup(); before.state.failBefore = "create";
    await expect((await before.operations()).execute(before.create)).rejects.toThrow();
    await expect((await before.operations()).execute(before.create))
      .resolves.toMatchObject({ receipt: { resulting_revision: 5 } });
    expect(mutationCount(before.state, "create")).toBe(2);

    const afterMutation = await setup(); afterMutation.state.crashAfter = "create";
    await expect((await afterMutation.operations()).execute(afterMutation.create)).rejects.toThrow();
    await expect((await afterMutation.operations()).execute(afterMutation.create))
      .resolves.toMatchObject({ receipt: { resulting_revision: 5 } });
    expect(mutationCount(afterMutation.state, "create")).toBe(1);

    const completion = await setup(); const real = await completion.openJournal(); let fail = true;
    const flaky: TargetJournalStore = { withLifecycleLease: (action) => real.withLifecycleLease(action), read: () => real.read(), reserve: (raw) => real.reserve(raw), resolveCompletedReceipt: (claim) => real.resolveCompletedReceipt(claim),
      complete: async (claim, raw) => {
        if (fail && (raw as { operation?: string }).operation === "create_world_service") {
          fail = false; throw new Error("private completion crash");
        }
        return real.complete(claim, raw);
      } };
    await expect((await completion.operations(flaky)).execute(completion.create)).rejects.toThrow();
    await expect((await completion.operations()).execute(completion.create))
      .resolves.toMatchObject({ receipt: { resulting_revision: 5 } });
    expect(mutationCount(completion.state, "create")).toBe(1);
  }, 20_000);

  it("recovers start before and after the exact mutation without duplicating success", async () => {
    for (const crash of ["before", "after"] as const) {
      const fixture = await setup(); const created = await (await fixture.operations()).execute(fixture.create);
      const start = fixture.startFor(created.receipt.result_handle!);
      if (crash === "before") fixture.state.failBefore = "start";
      else fixture.state.crashAfter = "start";
      await expect((await fixture.operations()).execute(start)).rejects.toThrow();
      await expect((await fixture.operations()).execute(start))
        .resolves.toMatchObject({ receipt: { resulting_revision: 6 } });
      expect(mutationCount(fixture.state, "start")).toBe(crash === "before" ? 2 : 1);
    }
  });

  it("recovers every stop/remove crash boundary from durable admission", async () => {
    for (const scenario of ["before-stop", "after-stop", "before-rm", "after-rm"] as const) {
      const fixture = await setup(); const created = await (await fixture.operations()).execute(fixture.create);
      const start = fixture.startFor(created.receipt.result_handle!);
      await (await fixture.operations()).execute(start);
      const stop = { ...start, expected_revision: 6, idempotency_key: key(7),
        operation: "stop_world_service" as const };
      if (scenario === "before-stop") fixture.state.failBefore = "stop";
      if (scenario === "after-stop") fixture.state.crashAfter = "stop";
      if (scenario === "before-rm") fixture.state.failBefore = "rm";
      if (scenario === "after-rm") fixture.state.crashAfter = "rm";
      await expect((await fixture.operations()).execute(stop)).rejects.toThrow();
      await expect((await fixture.operations()).execute(stop))
        .resolves.toMatchObject({ receipt: { result_handle: null, resulting_revision: 7 } });
      expect(fixture.state.container).toBeNull();
      expect(mutationCount(fixture.state, "stop")).toBe(scenario === "before-stop" ? 2 : 1);
      expect(mutationCount(fixture.state, "rm")).toBe(scenario === "before-rm" ? 2 : 1);
    }
  }, 20_000);

  it("never launders rejected fresh create, start, or stop state through retry", async () => {
    const createFixture = await setup();
    createFixture.state.container = { id: containerId, status: "created" };
    await expect((await createFixture.operations()).execute(createFixture.create)).rejects.toThrow();
    createFixture.state.container = null;
    await expect((await createFixture.operations()).execute(createFixture.create)).rejects.toThrow();
    expect(mutationCount(createFixture.state, "create")).toBe(0);

    const startFixture = await setup();
    const created = await (await startFixture.operations()).execute(startFixture.create);
    const start = startFixture.startFor(created.receipt.result_handle!);
    startFixture.state.container = { id: containerId, status: "running" };
    await expect((await startFixture.operations()).execute(start)).rejects.toThrow();
    startFixture.state.container = { id: containerId, status: "created" };
    await expect((await startFixture.operations()).execute(start)).rejects.toThrow();
    expect(mutationCount(startFixture.state, "start")).toBe(0);

    const stopFixture = await setup();
    const stoppedCreate = await (await stopFixture.operations()).execute(stopFixture.create);
    const stop = { ...stopFixture.startFor(stoppedCreate.receipt.result_handle!),
      idempotency_key: key(7), operation: "stop_world_service" as const };
    stopFixture.state.container = null;
    await expect((await stopFixture.operations()).execute(stop)).rejects.toThrow();
    stopFixture.state.container = { id: containerId, status: "running" };
    await expect((await stopFixture.operations()).execute(stop)).rejects.toThrow();
    expect(mutationCount(stopFixture.state, "stop")).toBe(0);
    expect(mutationCount(stopFixture.state, "rm")).toBe(0);
  });
});
