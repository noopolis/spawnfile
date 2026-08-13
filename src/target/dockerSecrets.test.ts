import { Buffer } from "node:buffer";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TARGET_RESOURCE_REQUEST_VERSION, type OpaqueTargetHandle, type SelectedTargetReceipt } from "./contracts.js";
import { createDockerSecretOperations, type TargetSecretSourceResolver } from "./dockerSecrets.js";
import {
  initializeTargetSecretVersionAuthorityStore,
  type TargetSecretSourceAuthorization,
  type TargetSecretVersionAuthorityStore
} from "./dockerSecretsAuthority.js";
import {
  DOCKER_SECRET_ERROR,
  DOCKER_SECRET_WRITER_IMAGE,
  MAX_SECRET_VALUE_BYTES,
  DockerSecretProviderError,
  createExistingDockerSecretSpec,
  createPreparedDockerSecretSpec,
  type DockerSecretExecutor
} from "./dockerSecretsProvider.js";
import { selectTarget } from "./dockerTarget.js";
import { initializeTargetJournal, type TargetJournalStore } from "./journal.js";

const descriptor = `sha256:${"a".repeat(64)}`;
const context = "test_context";
const endpoint = "unix:///private/test.sock";
const handle = (value: string) => `opaque_${value.padEnd(16, "a")}` as OpaqueTargetHandle;
const key = (index: number) => `idem_${String(index).padStart(16, "a")}`;
const roots: string[] = [];
const root = async (): Promise<string> => { const value = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-secrets-"))); roots.push(value); return value; };
afterEach(async () => { await Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true }))); });

interface Deferred { promise: Promise<void>; release(): void; }
const deferred = (): Deferred => { let release!: () => void; return { promise: new Promise((resolve) => { release = resolve; }), release }; };
interface LoggedCall { readonly args: string[]; readonly file: string; readonly hasStdin: boolean; readonly optionKeys: string[]; }
interface FakeWriter { readonly args: string[]; readonly labels: Record<string, string>; readonly name: string; readonly projection?: Record<string, unknown>; readonly volumeName: string; exitCode: number; status: string; }
interface FakeState {
  calls: LoggedCall[];
  badVolumeRmOutputOnce?: boolean;
  endpoint?: string;
  lastStdin?: Uint8Array;
  lastWriter?: FakeWriter;
  runGate?: Deferred;
  runCollisionOnce?: boolean;
  runBareCollisionOnce?: boolean;
  runStarted?: Deferred;
  waitStarted?: Deferred;
  volumes: Map<string, Record<string, string>>;
  volumeRmNotFoundOnce?: boolean;
  writerInputs: Buffer[];
  writerOutput?: string;
  writers: Map<string, FakeWriter>;
}
const labelsFrom = (args: string[]): Record<string, string> => Object.fromEntries(args.filter((_item, index) => args[index - 1] === "--label").map((item) => item.split("=", 2)));
const valueAfter = (args: string[], flag: string): string => args[args.indexOf(flag) + 1]!;
const writerProjection = (writer: FakeWriter): string => {
  const imageIndex = writer.args.indexOf(DOCKER_SECRET_WRITER_IMAGE);
  return JSON.stringify([{
    AutoRemove: true, BindCount: 0, CapAddCount: 0, CapDrop: ["ALL"], CgroupnsMode: "private",
    Cmd: writer.args.slice(imageIndex + 1), DeviceCount: 0, DeviceRequestCount: 0, DnsCount: 0, Domainname: "",
    Entrypoint: ["/bin/sh"], Env: ["PATH=/bin:/usr/bin", `HOSTNAME=${writer.name}`, "HOME=/root"], ExitCode: writer.exitCode,
    ExposedPortCount: 0, ExtraHostCount: 0, GroupAddCount: 0, Hostname: writer.name,
    Image: DOCKER_SECRET_WRITER_IMAGE, IpcMode: "none", Labels: writer.labels, LinkCount: 0, LogType: "none",
    Memory: 33_554_432, MountCount: 1,
    MountDestination: "/run/spawnfile-secrets", MountName: writer.volumeName, MountRW: true, MountType: "volume",
    Name: `/${writer.name}`, NanoCpus: 250_000_000, NetworkAttachmentCount: 1, NetworkAttachmentName: "none",
    NetworkMode: "none", OpenStdin: true, PidMode: "", PidsLimit: 32,
    PortBindingCount: 0, Privileged: false, PublishAllPorts: false, ReadonlyRootfs: true,
    RestartMaximumRetryCount: 0, RestartPolicyName: "no", SecurityOpt: ["no-new-privileges=true"],
    Status: writer.status, User: "0:0", UsernsMode: "", UTSMode: "", VolumesFromCount: 0,
    ...writer.projection
  }]);
};

const fake = (state: FakeState): DockerSecretExecutor => async (file, args, options) => {
  expect(file).toBe("docker");
  state.calls.push({ args: [...args], file, hasStdin: options.stdin !== undefined, optionKeys: Object.keys(options).sort() });
  if (args.includes("list") || args.includes("ls")) throw new Error("discovery is forbidden");
  if (args[0] === "context") return { stderr: "", stdout: JSON.stringify(state.endpoint ?? endpoint) };
  const kind = args[2]; const action = args[3];
  if (kind === "volume" && action === "inspect") {
    const name = args.at(-1)!; const labels = state.volumes.get(name); if (!labels) throw new DockerSecretProviderError("not_found");
    return { stderr: "", stdout: JSON.stringify([{ Driver: "local", Labels: labels, Name: name, Options: null, Scope: "local" }]) };
  }
  if (kind === "volume" && action === "create") {
    const name = args.at(-1)!; if (!state.volumes.has(name)) state.volumes.set(name, labelsFrom(args)); return { stderr: "", stdout: `${name}\n` };
  }
  if (kind === "volume" && action === "rm") {
    const name = args.at(-1)!;
    if (state.badVolumeRmOutputOnce) { state.badVolumeRmOutputOnce = false; state.volumes.delete(name); return { stderr: "", stdout: "unexpected-name\n" }; }
    if (state.volumeRmNotFoundOnce) { state.volumeRmNotFoundOnce = false; state.volumes.delete(name); throw new DockerSecretProviderError("not_found"); }
    if (!state.volumes.delete(name)) throw new DockerSecretProviderError("not_found"); return { stderr: "", stdout: `${name}\n` };
  }
  if (kind === "container" && action === "inspect") {
    const writer = state.writers.get(args.at(-1)!); if (!writer) throw new DockerSecretProviderError("not_found"); return { stderr: "", stdout: writerProjection(writer) };
  }
  if (kind === "container" && action === "stop") { const name = args.at(-1)!; const writer = state.writers.get(name); if (!writer) throw new DockerSecretProviderError("not_found"); writer.status = "exited"; return { stderr: "", stdout: `${name}\n` }; }
  if (kind === "container" && action === "rm") {
    const name = args.at(-1)!; if (!state.writers.delete(name)) throw new DockerSecretProviderError("not_found"); return { stderr: "", stdout: `${name}\n` };
  }
  if (kind === "container" && action === "wait") {
    const name = args.at(-1)!; const writer = state.writers.get(name); if (!writer) throw new DockerSecretProviderError("not_found");
    state.waitStarted?.release(); await state.runGate?.promise; return { stderr: "", stdout: `${writer.exitCode}\n` };
  }
  if (args[2] === "run") {
    const stdin = options.stdin; if (!(stdin instanceof Uint8Array)) throw new Error("writer stdin missing");
    state.lastStdin = stdin; state.writerInputs.push(Buffer.from(stdin));
    const name = valueAfter(args, "--name");
    if (state.writers.has(name)) throw new DockerSecretProviderError("collision");
    const mount = valueAfter(args, "--mount"); const volumeName = /(?:^|,)src=([^,]+)/u.exec(mount)?.[1]; if (!volumeName) throw new Error("volume missing");
    const writer: FakeWriter = { args: [...args.slice(2)], exitCode: 0, labels: labelsFrom(args), name, status: "running", volumeName };
    if (state.runBareCollisionOnce) { state.runBareCollisionOnce = false; throw new DockerSecretProviderError("collision"); }
    if (state.runCollisionOnce) { state.runCollisionOnce = false; writer.status = "exited"; writer.exitCode = 1; state.writers.set(name, writer); throw new DockerSecretProviderError("collision"); }
    state.writers.set(name, writer); state.lastWriter = { ...writer, args: [...writer.args], labels: { ...writer.labels } }; state.runStarted?.release();
    await state.runGate?.promise; state.writers.delete(name);
    return { stderr: "", stdout: state.writerOutput ?? "" };
  }
  throw new Error("unexpected Docker command");
};

const state = (changes: Partial<FakeState> = {}): FakeState => ({ calls: [], volumes: new Map(), writerInputs: [], writers: new Map(), ...changes });
const selectedFor = (executor: DockerSecretExecutor): Promise<SelectedTargetReceipt> => selectTarget({ context, execFile: executor });
interface TestSetup {
  readonly authorityRoot: string;
  readonly authorityStore: TargetSecretVersionAuthorityStore;
  readonly journal: TargetJournalStore;
  readonly selected: SelectedTargetReceipt;
}
const setup = async (
  current: FakeState, runId = "run-one", supplied?: SelectedTargetReceipt, suppliedAuthorityRoot?: string
): Promise<TestSetup> => {
  const selected = supplied ?? await selectedFor(fake(current)); const base = await root();
  const authorityRoot = suppliedAuthorityRoot ?? path.join(base, "secret-authority");
  const authorityStore = await initializeTargetSecretVersionAuthorityStore(authorityRoot);
  const journal = await initializeTargetJournal({ context, descriptorDigest: descriptor, root: path.join(base, "journal"), runId, selectedTarget: selected });
  return { authorityRoot, authorityStore, journal, selected };
};
const prepareRequest = (selected: SelectedTargetReceipt, changes: Record<string, unknown> = {}) => ({
  bindings: [{ name: "token", scope: "world", source_handle: handle("sourceone") }], descriptor_digest: descriptor,
  expected_revision: 0, idempotency_key: key(1), operation: "prepare_secret_bindings", run_id: "run-one",
  selected_target: { fingerprint: selected.fingerprint, handle: selected.handle }, version: TARGET_RESOURCE_REQUEST_VERSION, ...changes
});
const revokeRequest = (selected: SelectedTargetReceipt, bindingHandle: OpaqueTargetHandle, changes: Record<string, unknown> = {}) => ({
  descriptor_digest: descriptor, expected_revision: 1, idempotency_key: key(2), operation: "revoke_secret_bindings",
  run_id: "run-one", secret_bindings_handle: bindingHandle, selected_target: { fingerprint: selected.fingerprint, handle: selected.handle },
  version: TARGET_RESOURCE_REQUEST_VERSION, ...changes
});
const resolverFor = (
  secret: Buffer,
  calls: string[] = [],
  returned: Buffer[] = [],
  options: { readonly authorization?: TargetSecretSourceAuthorization; readonly versionHandle?: OpaqueTargetHandle } = {}
): TargetSecretSourceResolver => ({
  resolve: async ({ authorization }) => {
    calls.push(authorization.sourceHandle); const value = Buffer.from(secret); returned.push(value);
    return {
      authorization: options.authorization ?? authorization,
      sourceVersionHandle: options.versionHandle ?? handle("versionone"),
      value
    };
  }
});
const expectFixedFailure = async (promise: Promise<unknown>, sentinel?: string): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ code: "runtime_error", message: DOCKER_SECRET_ERROR });
  await promise.catch((error: unknown) => { if (sentinel) expect(String(error)).not.toContain(sentinel); });
};

describe("Docker secret materialization", () => {
  it("rejects malformed private authority options and non-secret operations before provider use", async () => {
    const current = state(); const { authorityStore, journal, selected } = await setup(current); const resolver = resolverFor(Buffer.from("unused")); const executor = fake(current);
    for (const changes of [
      { authorityStore: null }, { authorityStore: {} }, { context: "bad context" }, { executor: null }, { journal: null }, { resolver: null }, { resolver: {} },
      { timeoutMs: "10" }, { timeoutMs: 0 }, { timeoutMs: 120_001 }
    ]) expect(() => createDockerSecretOperations({ authorityStore, context, executor, journal, resolver, ...changes } as never)).toThrow(DOCKER_SECRET_ERROR);
    const operations = createDockerSecretOperations({ authorityStore, context, executor, journal, resolver });
    const { bindings: _bindings, ...networkRequest } = prepareRequest(selected);
    await expectFixedFailure(operations.execute({ ...networkRequest, operation: "create_data_network" }));
    expect((await journal.read()).entries).toHaveLength(0);
  });

  it("puts values only on writer stdin, emits a secret-free receipt, clears memory, and replays without authority", async () => {
    const current = state(); const { authorityStore, journal, selected } = await setup(current); const secret = Buffer.from("sentinel-live-secret");
    const resolverCalls: string[] = []; const returned: Buffer[] = []; const operations = createDockerSecretOperations({ authorityStore, context, executor: fake(current), journal, resolver: resolverFor(secret, resolverCalls, returned) });
    const request = prepareRequest(selected); const result = await operations.execute(request);
    expect(current.writerInputs).toHaveLength(1); expect(current.writerInputs[0]!.includes(secret)).toBe(true);
    expect(current.lastStdin).toBeDefined(); expect([...current.lastStdin!].every((byte) => byte === 0)).toBe(true);
    expect(returned).toHaveLength(1); expect([...returned[0]!].every((byte) => byte === 0)).toBe(true);
    expect(resolverCalls).toEqual([handle("sourceone")]);
    expect(result.receipt.result_handle).toMatch(/^opaque_[a-f0-9]{64}$/u); expect(result.receipt.resulting_revision).toBe(1);
    expect(result.receiptBytes).toBe(JSON.stringify(result.receipt)); expect(result.receipt.labels).toHaveLength(5);
    const publicEvidence = JSON.stringify({ calls: current.calls, journal: await journal.read(), receipt: result.receipt });
    expect(publicEvidence).not.toContain(secret.toString()); expect(publicEvidence).not.toContain(handle("sourceone"));
    expect(current.calls.filter(({ hasStdin }) => hasStdin)).toHaveLength(1);
    expect(current.calls.find(({ hasStdin }) => hasStdin)!.optionKeys).toEqual(["signal", "stdin", "timeout"]);
    expect(current.calls.every(({ args }) => !args.some((arg) => arg.includes(secret.toString())))).toBe(true);
    const before = current.calls.length; expect(await operations.execute(request)).toEqual(result); expect(current.calls).toHaveLength(before); expect(resolverCalls).toHaveLength(1);
  });

  it("joins one live request across operation instances and waits for the exact active writer", async () => {
    const gate = deferred(); const started = deferred(); const waitStarted = deferred(); const current = state({ runGate: gate, runStarted: started, waitStarted });
    const { authorityStore, journal, selected } = await setup(current); const resolverCalls: string[] = []; const resolver = resolverFor(Buffer.from("same-secret"), resolverCalls);
    const left = createDockerSecretOperations({ authorityStore, context, executor: fake(current), journal, resolver });
    const right = createDockerSecretOperations({ authorityStore, context, executor: fake(current), journal, resolver }); const request = prepareRequest(selected);
    const first = left.execute(request); await started.promise; const second = right.execute(request); await waitStarted.promise; gate.release();
    const [one, two] = await Promise.all([first, second]); expect(one).toEqual(two); expect(current.writerInputs).toHaveLength(1); expect(resolverCalls).toHaveLength(2);
    expect(current.calls.filter(({ args }) => args[2] === "container" && args[3] === "wait")).toHaveLength(1);
  });

  it("joins an exact same-instance request and rejects changed same-key bytes before another provider call", async () => {
    const gate = deferred(); const started = deferred(); const current = state({ runGate: gate, runStarted: started }); const { authorityStore, journal, selected } = await setup(current);
    const operations = createDockerSecretOperations({ authorityStore, context, executor: fake(current), journal, resolver: resolverFor(Buffer.from("live-secret")) }); const request = prepareRequest(selected);
    const first = operations.execute(request); await started.promise; const exact = operations.execute(request); const before = current.calls.length;
    await expectFixedFailure(operations.execute({ ...request, bindings: [{ name: "other", scope: "world", source_handle: handle("sourcetwo") }] }));
    expect(current.calls).toHaveLength(before); gate.release(); expect(await exact).toEqual(await first); expect(current.writerInputs).toHaveLength(1);
  });

  it("binds a completion-crash retry to one durable opaque source version before rewriting", async () => {
    const current = state(); const base = await setup(current); let failCompletion = true;
    const journal: TargetJournalStore = {
      withLifecycleLease: (action) => base.journal.withLifecycleLease(action),
      read: () => base.journal.read(), reserve: (raw) => base.journal.reserve(raw),
      resolveCompletedReceipt: (claim) => base.journal.resolveCompletedReceipt(claim),
      complete: async (claim, receipt) => { if (failCompletion) { failCompletion = false; throw new Error("sentinel-completion-detail"); } return base.journal.complete(claim, receipt); }
    };
    const resolverCalls: string[] = []; const operations = createDockerSecretOperations({ authorityStore: base.authorityStore, context, executor: fake(current), journal, resolver: resolverFor(Buffer.from("retry-secret"), resolverCalls) });
    const request = prepareRequest(base.selected); await expectFixedFailure(operations.execute(request), "sentinel-completion-detail");
    const beforeDrift = current.writerInputs.length;
    const drift = createDockerSecretOperations({
      authorityStore: await initializeTargetSecretVersionAuthorityStore(base.authorityRoot), context,
      executor: fake(current), journal, resolver: resolverFor(Buffer.from("changed-secret"), [], [], { versionHandle: handle("versiontwo") })
    });
    await expectFixedFailure(drift.execute(request)); expect(current.writerInputs).toHaveLength(beforeDrift);
    const recovered = createDockerSecretOperations({
      authorityStore: await initializeTargetSecretVersionAuthorityStore(base.authorityRoot), context,
      executor: fake(current), journal, resolver: resolverFor(Buffer.from("retry-secret"), resolverCalls)
    });
    const result = await recovered.execute(request); expect(result.receipt.resulting_revision).toBe(1);
    expect(current.writerInputs).toHaveLength(2); expect(current.writerInputs[0]).toEqual(current.writerInputs[1]); expect(resolverCalls).toHaveLength(2);
  });

  it("requires resolver authorization for the exact run, target, claim, scope, and name", async () => {
    const grants: TargetSecretSourceAuthorization[] = [];
    const resolver: TargetSecretSourceResolver = { resolve: async ({ authorization }) => {
      grants.push(authorization);
      return { authorization, sourceVersionHandle: handle("versionone"), value: Buffer.from("scoped-secret") };
    } };
    const current = state(); const base = await setup(current);
    const operations = createDockerSecretOperations({ authorityStore: base.authorityStore, context, executor: fake(current), journal: base.journal, resolver });
    await operations.execute(prepareRequest(base.selected));
    expect(grants[0]).toMatchObject({ descriptorDigest: descriptor, name: "token", runId: "run-one", scope: "world", sourceHandle: handle("sourceone") });

    const beforeScope = current.writerInputs.length;
    await expectFixedFailure(operations.execute(prepareRequest(base.selected, {
      bindings: [{ name: "token", scope: "agent", source_handle: handle("sourceone") }],
      expected_revision: 1, idempotency_key: key(2)
    })));
    expect(current.writerInputs).toHaveLength(beforeScope);

    const runState = state(); const runSetup = await setup(runState, "run-two", base.selected, base.authorityRoot);
    await expectFixedFailure(createDockerSecretOperations({
      authorityStore: runSetup.authorityStore, context, executor: fake(runState), journal: runSetup.journal, resolver
    }).execute(prepareRequest(runSetup.selected, { run_id: "run-two" })));
    expect(runState.writerInputs).toHaveLength(0);

    const targetState = state({ endpoint: "unix:///private/other.sock" }); const targetSelected = await selectedFor(fake(targetState));
    const targetSetup = await setup(targetState, "run-one", targetSelected, base.authorityRoot);
    await expectFixedFailure(createDockerSecretOperations({
      authorityStore: targetSetup.authorityStore, context, executor: fake(targetState), journal: targetSetup.journal, resolver
    }).execute(prepareRequest(targetSetup.selected)));
    expect(targetState.writerInputs).toHaveLength(0);
  });

  it("removes one exact stale collision and retries the same zero-retained stdin payload", async () => {
    const current = state({ runCollisionOnce: true }); const { authorityStore, journal, selected } = await setup(current);
    const operations = createDockerSecretOperations({ authorityStore, context, executor: fake(current), journal, resolver: resolverFor(Buffer.from("collision-secret")) });
    const result = await operations.execute(prepareRequest(selected)); expect(result.receipt.resulting_revision).toBe(1);
    expect(current.writerInputs).toHaveLength(2); expect(current.writerInputs[0]).toEqual(current.writerInputs[1]);
    expect(current.calls.filter(({ args }) => args[2] === "container" && args[3] === "rm")).toHaveLength(1);
  });

  it("retries once when a classified collision disappears before exact inspection", async () => {
    const current = state({ runBareCollisionOnce: true }); const { authorityStore, journal, selected } = await setup(current);
    const result = await createDockerSecretOperations({ authorityStore, context, executor: fake(current), journal, resolver: resolverFor(Buffer.from("race-secret")) }).execute(prepareRequest(selected));
    expect(result.receipt.resulting_revision).toBe(1); expect(current.writerInputs).toHaveLength(2);
  });

  it("recovers an exact pending writer that exited nonzero before rewriting", async () => {
    const current = state(); const { authorityStore, journal, selected } = await setup(current); const request = prepareRequest(selected); const reservation = await journal.reserve(request);
    if (reservation.kind !== "owner") throw new Error("owner claim missing");
    const spec = createPreparedDockerSecretSpec({ operationHandle: reservation.claim.operationHandle, requestDigest: reservation.claim.requestDigest, runId: "run-one", selectedTargetHandle: selected.handle });
    current.volumes.set(spec.volumeName, { ...spec.labels }); current.writers.set(spec.writerName, {
      args: [...spec.writerRunArgs], exitCode: 7, labels: { ...spec.writerLabels }, name: spec.writerName, status: "running", volumeName: spec.volumeName
    });
    const result = await createDockerSecretOperations({ authorityStore, context, executor: fake(current), journal, resolver: resolverFor(Buffer.from("recovered-secret")) }).execute(request);
    expect(result.receipt.resulting_revision).toBe(1); expect(current.writerInputs).toHaveLength(1);
    expect(current.calls.some(({ args }) => args[2] === "container" && args[3] === "wait")).toBe(true);
    expect(current.calls.some(({ args }) => args[2] === "container" && args[3] === "rm")).toBe(true);
  });

  it("never waits for, removes, or adopts a writer with a live foreign network attachment", async () => {
    const current = state(); const { authorityStore, journal, selected } = await setup(current);
    const request = prepareRequest(selected); const reservation = await journal.reserve(request);
    if (reservation.kind !== "owner") throw new Error("owner claim missing");
    const spec = createPreparedDockerSecretSpec({ operationHandle: reservation.claim.operationHandle, requestDigest: reservation.claim.requestDigest, runId: "run-one", selectedTargetHandle: selected.handle });
    current.volumes.set(spec.volumeName, { ...spec.labels }); current.writers.set(spec.writerName, {
      args: [...spec.writerRunArgs], exitCode: 0, labels: { ...spec.writerLabels }, name: spec.writerName,
      projection: { NetworkAttachmentCount: 2, NetworkAttachmentName: "bridge" }, status: "running", volumeName: spec.volumeName
    });
    await expectFixedFailure(createDockerSecretOperations({
      authorityStore, context, executor: fake(current), journal, resolver: resolverFor(Buffer.from("never-written"))
    }).execute(request));
    expect(current.writerInputs).toHaveLength(0);
    expect(current.calls.some(({ args }) => args[2] === "container" && (args[3] === "wait" || args[3] === "rm"))).toBe(false);
    expect(current.writers.has(spec.writerName)).toBe(true);
  });

  it("rejects duplicate destinations, resolver failures, oversized values, and target drift before writer stdin", async () => {
    const current = state(); const { authorityStore, journal, selected } = await setup(current); const sentinel = "sentinel-resolver-error";
    const broken: TargetSecretSourceResolver = { resolve: async () => { throw new Error(sentinel); } };
    const operations = createDockerSecretOperations({ authorityStore, context, executor: fake(current), journal, resolver: broken });
    await expectFixedFailure(operations.execute(prepareRequest(selected)), sentinel); expect(current.writerInputs).toHaveLength(0); expect(current.volumes.size).toBe(0);

    const duplicateState = state(); const duplicateSetup = await setup(duplicateState); const duplicate = prepareRequest(duplicateSetup.selected, { bindings: [
      { name: "token", scope: "world", source_handle: handle("sourceone") }, { name: "token", scope: "world", source_handle: handle("sourcetwo") }
    ] });
    await expectFixedFailure(createDockerSecretOperations({ authorityStore: duplicateSetup.authorityStore, context, executor: fake(duplicateState), journal: duplicateSetup.journal, resolver: resolverFor(Buffer.from("unused")) }).execute(duplicate));
    expect((await duplicateSetup.journal.read()).entries).toHaveLength(0);

    const oversizedState = state(); const oversizedSetup = await setup(oversizedState); const oversized = Buffer.alloc(MAX_SECRET_VALUE_BYTES + 1, 7);
    await expectFixedFailure(createDockerSecretOperations({ authorityStore: oversizedSetup.authorityStore, context, executor: fake(oversizedState), journal: oversizedSetup.journal, resolver: resolverFor(oversized) }).execute(prepareRequest(oversizedSetup.selected)));
    expect(oversizedState.writerInputs).toHaveLength(0); expect(oversizedState.volumes.size).toBe(0);

    const wrongTypeState = state(); const wrongTypeSetup = await setup(wrongTypeState); const wrongType = { resolve: async () => "not-bytes" as never };
    await expectFixedFailure(createDockerSecretOperations({ authorityStore: wrongTypeSetup.authorityStore, context, executor: fake(wrongTypeState), journal: wrongTypeSetup.journal, resolver: wrongType }).execute(prepareRequest(wrongTypeSetup.selected)));
    expect(wrongTypeState.writerInputs).toHaveLength(0);

    const wrongAuthState = state(); const wrongAuthSetup = await setup(wrongAuthState); const wrongAuth: TargetSecretSourceResolver = { resolve: async ({ authorization }) => ({ authorization: { ...authorization, scope: "other" }, sourceVersionHandle: handle("versionone"), value: Buffer.from("must-clear") }) };
    await expectFixedFailure(createDockerSecretOperations({ authorityStore: wrongAuthSetup.authorityStore, context, executor: fake(wrongAuthState), journal: wrongAuthSetup.journal, resolver: wrongAuth }).execute(prepareRequest(wrongAuthSetup.selected)));
    expect(wrongAuthState.writerInputs).toHaveLength(0);

    const drift = state({ endpoint: "unix:///different.sock" });
    await expectFixedFailure(createDockerSecretOperations({ authorityStore: oversizedSetup.authorityStore, context, executor: fake(drift), journal: oversizedSetup.journal, resolver: resolverFor(Buffer.from("never")) }).execute(prepareRequest(oversizedSetup.selected)));
    expect(drift.writerInputs).toHaveLength(0); expect(drift.volumes.size).toBe(0);
  });

  it("rejects writer output without reflecting it or retaining the archive", async () => {
    const sentinel = "sentinel-echoed-secret"; const current = state({ writerOutput: sentinel }); const { authorityStore, journal, selected } = await setup(current); const returned: Buffer[] = [];
    const operations = createDockerSecretOperations({ authorityStore, context, executor: fake(current), journal, resolver: resolverFor(Buffer.from(sentinel), [], returned) });
    await expectFixedFailure(operations.execute(prepareRequest(selected)), sentinel);
    expect([...current.lastStdin!].every((byte) => byte === 0)).toBe(true); expect([...returned[0]!].every((byte) => byte === 0)).toBe(true);
    expect(JSON.stringify({ calls: current.calls, journal: await journal.read() })).not.toContain(sentinel);
  });
});
describe("Docker secret revocation", () => {
  it("removes only the exact writer and volume, survives a completion crash, and replays", async () => {
    const current = state(); const base = await setup(current); const normal = createDockerSecretOperations({ authorityStore: base.authorityStore, context, executor: fake(current), journal: base.journal, resolver: resolverFor(Buffer.from("revoke-secret")) });
    const prepared = await normal.execute(prepareRequest(base.selected)); const bindingHandle = prepared.receipt.result_handle!;
    const spec = createExistingDockerSecretSpec({ bindingsHandle: bindingHandle, runId: "run-one", selectedTargetHandle: base.selected.handle });
    if (!current.lastWriter) throw new Error("writer template missing"); current.writers.set(spec.writerName, { ...current.lastWriter, status: "running" }); current.volumeRmNotFoundOnce = true;
    let crash = true; const journal: TargetJournalStore = {
      withLifecycleLease: (action) => base.journal.withLifecycleLease(action),
      read: () => base.journal.read(), reserve: (raw) => base.journal.reserve(raw),
      resolveCompletedReceipt: (claim) => base.journal.resolveCompletedReceipt(claim),
      complete: async (claim, receipt) => { if (crash) { crash = false; throw new Error("sentinel-revoke-crash"); } return base.journal.complete(claim, receipt); }
    };
    const operations = createDockerSecretOperations({ authorityStore: base.authorityStore, context, executor: fake(current), journal, resolver: resolverFor(Buffer.from("must-not-resolve")) }); const request = revokeRequest(base.selected, bindingHandle);
    await expectFixedFailure(operations.execute(request), "sentinel-revoke-crash"); expect(current.volumes.has(spec.volumeName)).toBe(false); expect(current.writers.has(spec.writerName)).toBe(false);
    const result = await operations.execute(request); expect(result.receipt.result_handle).toBeNull(); expect(result.receipt.resulting_revision).toBe(2);
    const before = current.calls.length; expect(await operations.execute(request)).toEqual(result); expect(current.calls).toHaveLength(before);
    expect(current.calls.some(({ args }) => args.includes("list") || args.includes("ls"))).toBe(false);
  });

  it("refuses a forged exact-name volume without removing it", async () => {
    const current = state(); const base = await setup(current); const normal = createDockerSecretOperations({ authorityStore: base.authorityStore, context, executor: fake(current), journal: base.journal, resolver: resolverFor(Buffer.from("secret")) });
    const prepared = await normal.execute(prepareRequest(base.selected)); const bindingHandle = prepared.receipt.result_handle!;
    const spec = createExistingDockerSecretSpec({ bindingsHandle: bindingHandle, runId: "run-one", selectedTargetHandle: base.selected.handle }); current.volumes.set(spec.volumeName, { ...spec.labels, forged: "value" });
    const beforeRemoves = current.calls.filter(({ args }) => args[2] === "volume" && args[3] === "rm").length;
    await expectFixedFailure(normal.execute(revokeRequest(base.selected, bindingHandle)));
    expect(current.volumes.has(spec.volumeName)).toBe(true); expect(current.calls.filter(({ args }) => args[2] === "volume" && args[3] === "rm")).toHaveLength(beforeRemoves);
  });

  it("fails closed on malformed remove output and completes only after exact absent recovery", async () => {
    const current = state(); const base = await setup(current); const operations = createDockerSecretOperations({ authorityStore: base.authorityStore, context, executor: fake(current), journal: base.journal, resolver: resolverFor(Buffer.from("secret")) });
    const prepared = await operations.execute(prepareRequest(base.selected)); const bindingHandle = prepared.receipt.result_handle!; current.badVolumeRmOutputOnce = true;
    const request = revokeRequest(base.selected, bindingHandle); await expectFixedFailure(operations.execute(request));
    const result = await operations.execute(request); expect(result.receipt.resulting_revision).toBe(2); expect(result.receipt.result_handle).toBeNull();
  });
});
