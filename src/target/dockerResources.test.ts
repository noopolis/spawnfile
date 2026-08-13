import os from "node:os";
import path from "node:path";
import { mkdtemp, realpath, rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { TARGET_RESOURCE_REQUEST_VERSION, type SelectedTargetReceipt } from "./contracts.js";
import { createDockerResourceOperations } from "./dockerResources.js";
import { DockerResourceProviderError, createDockerResourceSpec, type DockerResourceExecutor } from "./dockerResourcesProvider.js";
import { selectTarget } from "./dockerTarget.js";
import { initializeTargetJournal, type TargetJournalStore } from "./journal.js";

const digest = `sha256:${"a".repeat(64)}`;
const context = "test_context";
const roots: string[] = [];
const key = (index: number): string => `idem_${String(index).padStart(16, "a")}`;
const root = async (): Promise<string> => { const value = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-resources-"))); roots.push(value); return value; };
afterEach(async () => { await Promise.all(roots.splice(0).map((value) => rm(value, { force: true, maxRetries: 3, recursive: true, retryDelay: 10 }))); });

interface Deferred { promise: Promise<void>; release(): void; }
interface FakeState { calls: string[][]; collision?: boolean; createGate?: Deferred; createStarted?: Deferred; resources: Map<string, { internal?: boolean; labels: Record<string, string> }>; }
const deferred = (): Deferred => { let release!: () => void; return { promise: new Promise<void>((resolve) => { release = resolve; }), release }; };
const fake = (state: FakeState, endpoint = "unix:///private/test.sock"): DockerResourceExecutor => async (_file, args) => {
  expect(_file).toBe("docker");
  state.calls.push(args);
  if (args.includes("list")) throw new Error("list must never run");
  if (args[0] === "context") return { stderr: "", stdout: JSON.stringify(endpoint) };
  const name = args.at(-1)!; const type = args[2] === "network" ? "network" : "volume";
  if (args[3] === "inspect") {
    const resource = state.resources.get(name); if (!resource) throw new DockerResourceProviderError("not_found");
    return { stderr: "", stdout: JSON.stringify([{ ...(type === "network" ? { Internal: resource.internal } : {}), Labels: resource.labels, Name: name }]) };
  }
  const labels = Object.fromEntries(args.filter((item, index) => args[index - 1] === "--label").map((item) => item.split("=", 2)));
  state.createStarted?.release(); await state.createGate?.promise;
  if (state.collision) { state.collision = false; state.resources.set(name, { internal: type === "network", labels }); throw new DockerResourceProviderError("collision"); }
  state.resources.set(name, { internal: type === "network", labels }); return { stderr: "", stdout: "raw-docker-id" };
};
const selectedFor = async (executor: DockerResourceExecutor): Promise<SelectedTargetReceipt> => selectTarget({ context, execFile: executor });
const request = (selected: SelectedTargetReceipt, changes: Record<string, unknown> = {}) => ({ descriptor_digest: digest, expected_revision: 0, idempotency_key: key(1), operation: "create_data_network", run_id: "run-one", selected_target: { fingerprint: selected.fingerprint, handle: selected.handle }, version: TARGET_RESOURCE_REQUEST_VERSION, ...changes });
const setup = async (state: FakeState, supplied?: SelectedTargetReceipt): Promise<{ journal: TargetJournalStore; selected: SelectedTargetReceipt }> => {
  const selected = supplied ?? await selectedFor(fake(state));
  return { journal: await initializeTargetJournal({ context, descriptorDigest: digest, root: await root(), runId: "run-one", selectedTarget: selected }), selected };
};

describe("Docker resource mutations", () => {
  it("creates the internal network and evidence volume with exact bounded argv, labels, receipts, and replay", async () => {
    const state: FakeState = { calls: [], resources: new Map() }; const { journal, selected } = await setup(state); const operations = createDockerResourceOperations({ context, executor: fake(state), journal });
    const network = await operations.execute(request(selected)); const volumeRequest = request(selected, { expected_revision: 1, idempotency_key: key(2), operation: "create_evidence_volume" }); const volume = await operations.execute(volumeRequest);
    const creates = state.calls.filter((args) => args.includes("create"));
    expect(creates[0]!.slice(0, 5)).toEqual(["--context", context, "network", "create", "--internal"]); expect(creates[0]!.filter((item) => item === "--label")).toHaveLength(5);
    expect(creates[1]!.slice(0, 4)).toEqual(["--context", context, "volume", "create"]); expect(creates[1]).not.toContain("--internal"); expect(creates[1]!.filter((item) => item === "--label")).toHaveLength(5);
    expect(network.receiptBytes).toBe(JSON.stringify(network.receipt)); expect(volume.receipt.resulting_revision).toBe(2); expect(network.receipt.result_handle).not.toBe(volume.receipt.result_handle);
    expect(network.receipt.labels).toHaveLength(5); expect(JSON.stringify(network.receipt)).not.toMatch(/raw-docker-id|spfn_|test_context|private\/test/);
    const before = state.calls.length; expect(await operations.execute(request(selected))).toEqual(network); expect(state.calls).toHaveLength(before); expect((await journal.read()).revision).toBe(2);
  });

  it("joins a live exact request before it can duplicate a blocked create", async () => {
    const gate = deferred(); const started = deferred(); const state: FakeState = { calls: [], createGate: gate, createStarted: started, resources: new Map() };
    const { journal, selected } = await setup(state); const operations = createDockerResourceOperations({ context, executor: fake(state), journal }); const first = request(selected);
    const owner = operations.execute(first); await started.promise;
    const joined = operations.execute(first); expect(state.calls.filter((args) => args.includes("create"))).toHaveLength(1);
    const beforeChanged = state.calls.length;
    await expect(operations.execute({ ...first, operation: "create_evidence_volume" })).rejects.toMatchObject({ message: "Docker resource mutation failed" });
    expect(state.calls).toHaveLength(beforeChanged);
    gate.release(); const [left, right] = await Promise.all([owner, joined]);
    expect(left.receiptBytes).toBe(right.receiptBytes); expect((await journal.read()).revision).toBe(1);
    expect(state.calls.filter((args) => args.includes("create"))).toHaveLength(1);
  });

  it("rejects different keys and stale requests before Docker", async () => {
    const state: FakeState = { calls: [], resources: new Map() }; const { journal, selected } = await setup(state); const operations = createDockerResourceOperations({ context, executor: fake(state), journal }); const first = request(selected);
    await operations.execute(first); const before = state.calls.length;
    await expect(operations.execute({ ...first, expected_revision: 0, idempotency_key: key(2) })).rejects.toMatchObject({ message: "Docker resource mutation failed" });
    expect(state.calls).toHaveLength(before);
  });

  it("recovers pending claims before creation, after a completion crash, and from an exact collision only", async () => {
    const state: FakeState = { calls: [], resources: new Map() }; const { journal, selected } = await setup(state); const first = request(selected); await journal.reserve(first);
    const operations = createDockerResourceOperations({ context, executor: fake(state), journal }); await expect(operations.execute(first)).resolves.toMatchObject({ receipt: { resulting_revision: 1 } });
    const pendingInspect = state.calls.find((args) => args[3] === "inspect"); const pending = await journal.reserve(first);
    if (!pendingInspect || pending.kind !== "replay") throw new Error("missing inspection");
    const spec = createDockerResourceSpec({ kind: "data_network", operationHandle: pending.receipt.operation_handle, requestDigest: pending.receipt.request_digest, runId: first.run_id, selectedTargetHandle: first.selected_target.handle });
    expect(pendingInspect).toEqual(["--context", context, "network", "inspect", "--format", spec.inspectionFormat, spec.name]);
    const state2: FakeState = { calls: [], resources: new Map(), collision: true }; const setup2 = await setup(state2); const collision = createDockerResourceOperations({ context, executor: fake(state2), journal: setup2.journal }); await expect(collision.execute(request(setup2.selected))).resolves.toMatchObject({ receipt: { resulting_revision: 1 } });
    const state3: FakeState = { calls: [], resources: new Map() }; const setup3 = await setup(state3); let complete = true; const flaky: TargetJournalStore = { withLifecycleLease: (action) => setup3.journal.withLifecycleLease(action), read: () => setup3.journal.read(), reserve: (raw) => setup3.journal.reserve(raw), resolveCompletedReceipt: (claim) => setup3.journal.resolveCompletedReceipt(claim), complete: async (claim, receipt) => { if (complete) { complete = false; throw new Error("secret-bearing completion failure"); } return setup3.journal.complete(claim, receipt); } };
    const crash = createDockerResourceOperations({ context, executor: fake(state3), journal: flaky }); await expect(crash.execute(request(setup3.selected))).rejects.toMatchObject({ message: "Docker resource mutation failed" }); await expect(crash.execute(request(setup3.selected))).resolves.toMatchObject({ receipt: { resulting_revision: 1 } });
  });

  it("rejects a selected-target/context mismatch before resource mutation and never enumerates", async () => {
    const state: FakeState = { calls: [], resources: new Map() }; const selected = await selectedFor(fake(state)); const { journal } = await setup(state, selected); const operations = createDockerResourceOperations({ context, executor: fake(state, "unix:///different.sock"), journal });
    await expect(operations.execute(request(selected))).rejects.toMatchObject({ message: "Docker resource mutation failed" }); expect(state.calls.some((args) => args.includes("create") || args.includes("list"))).toBe(false);
  });
});
