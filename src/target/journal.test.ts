import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TARGET_RESOURCE_RECEIPT_VERSION, TARGET_RESOURCE_REQUEST_VERSION } from "./contracts.js";
import {
  createCanonicalTargetOperationLookupBytes, createPendingReceiptDigest,
  createTargetReceiptDigest, createTargetRequestDigest
} from "./handles.js";
import {
  initializeTargetJournal, lookupTargetOperation, openExistingTargetJournal,
  setTargetJournalFilesystemForTests, type TargetJournalClaim, type TargetJournalStore
} from "./journal.js";

const digest = `sha256:${"a".repeat(64)}`;
const target = { fingerprint: `sha256:${"b".repeat(32)}`, handle: `opaque_${"c".repeat(16)}` } as const;
const selected = { ...target, version: "spawnfile.target-resource.selected-target.v1" } as const;
const roots: string[] = [];
const root = async (): Promise<string> => { const value = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-journal-"))); roots.push(value); return value; };
afterEach(async () => { await Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true }))); });
const key = (index: number): string => `idem_${index.toString(36).padStart(16, "a")}`;
const handle = (index: number): string => `opaque_${index.toString(36).padStart(16, "a")}`;
const request = (changes: Record<string, unknown> = {}) => ({ descriptor_digest: digest, expected_revision: 0, idempotency_key: key(1), operation: "create_data_network", run_id: "run-one", selected_target: target, version: TARGET_RESOURCE_REQUEST_VERSION, ...changes });
const receipt = (claim: TargetJournalClaim, revision: number, changes: Record<string, unknown> = {}) => {
  const value = { cleanup_state: "not_requested", descriptor_digest: digest, export_state: "not_requested", labels: [], operation: "create_data_network", operation_handle: claim.operationHandle, receipt_digest: digest, request_digest: claim.requestDigest, result_handle: handle(revision), resulting_revision: revision, run_id: "run-one", selected_target: target, version: TARGET_RESOURCE_RECEIPT_VERSION, ...changes };
  return { ...value, receipt_digest: createTargetReceiptDigest(value) };
};
const open = async (directory?: string): Promise<TargetJournalStore> => initializeTargetJournal({ context: "production", descriptorDigest: digest, root: directory ?? await root(), runId: "run-one", selectedTarget: selected });
const recordPath = async (directory: string): Promise<string> => path.join(directory, (await readdir(directory)).find((item) => item.endsWith(".json"))!);
const failed = async (promise: Promise<unknown>): Promise<void> => { await expect(promise).rejects.toMatchObject({ code: "runtime_error", message: "Target journal failed" }); await promise.catch((error: unknown) => expect(String(error)).not.toContain("sentinel")); };
const owner = async (journal: TargetJournalStore, raw: Record<string, unknown>): Promise<TargetJournalClaim> => { const value = await journal.reserve(raw); expect(value.kind).toBe("owner"); if (value.kind !== "owner") throw new Error("expected owner"); return value.claim; };
const complete = async (journal: TargetJournalStore, raw: Record<string, unknown>, changes: Record<string, unknown> = {}): Promise<TargetJournalClaim> => { const claim = await owner(journal, raw); const revision = (await journal.read()).revision + 1; await journal.complete(claim, receipt(claim, revision, { operation: raw.operation, ...changes })); return claim; };

describe("target journal", () => {
  it("serializes full lifecycle work separately from nested journal mutations", async () => {
    const journal = await open();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let secondEntered = false;
    const first = journal.withLifecycleLease!(async () => {
      await journal.reserve(request());
      await held;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = journal.withLifecycleLease!(async () => { secondEntered = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondEntered).toBe(false);
    release!();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
  });

  it("opens an existing correlation read-only and never seeds a missing one", async () => {
    const directory = await root();
    await failed(openExistingTargetJournal({
      context: "production", descriptorDigest: digest, root: directory, runId: "run-one", selectedTarget: selected
    }));
    expect(await readdir(directory)).toEqual([]);
    const seeded = await open(directory);
    await expect(openExistingTargetJournal({
      context: "production", descriptorDigest: digest, root: directory, runId: "run-one", selectedTarget: selected
    })).resolves.toBeDefined();
    expect(await seeded.read()).toMatchObject({ run_id: "run-one" });
  });

  it("persists pending before ownership, canonical replay bytes, permissions, and no list API", async () => {
    const directory = await root(); const journal = await open(directory); const claimed = await owner(journal, request());
    expect(await journal.read()).toEqual({ descriptor_digest: digest, entries: [{ operation: "create_data_network", operation_handle: claimed.operationHandle, receipt_digest: createPendingReceiptDigest(claimed.operationHandle, claimed.requestDigest), request_digest: claimed.requestDigest, state: "pending" }], revision: 0, run_id: "run-one", selected_target: target, version: "spawnfile.target-resource.journal.v1" });
    expect((await journal.read()).entries).toMatchObject([{ state: "pending", operation_handle: claimed.operationHandle }]);
    const done = await journal.complete(claimed, receipt(claimed, 1)); const replay = await journal.reserve(request());
    expect(replay).toEqual({ kind: "replay", receipt: done.receipt, receiptBytes: done.receiptBytes });
    await expect(journal.complete(claimed, done.receipt)).resolves.toEqual(done);
    await failed(journal.complete(claimed, { ...done.receipt, labels: [{ key: "changed", value: "changed" }] }));
    const file = await recordPath(directory); expect(file).not.toContain("run-one"); expect(file).not.toContain("production");
    expect(JSON.stringify(await journal.read())).not.toContain("production"); expect((await lstat(directory)).mode & 0o077).toBe(0); expect((await lstat(file)).mode & 0o077).toBe(0);
    expect(Object.getOwnPropertyNames(journal)).toEqual([]); expect("list" in journal).toBe(false);
  });

  it("allows only one fresh mutation at a revision while exact same-key joins", async () => {
    const directory = await root(); const left = await open(directory); const right = await open(directory);
    const same = await Promise.all([left.reserve(request()), right.reserve(request())]);
    expect(same.map((value) => value.kind).sort()).toEqual(["owner", "pending"]);
    await failed(left.reserve(request({ operation: "create_evidence_volume" })));
    const third = request({ idempotency_key: key(2), operation: "create_evidence_volume" }); await failed(left.reserve(third));
    await failed(left.reserve(request({ expected_revision: 7, idempotency_key: key(3) })));
    expect((await left.read()).entries).toHaveLength(1);
  });

  it("contests distinct concurrent keys and operations so exactly one gets ownership", async () => {
    const directory = await root(); const left = await open(directory); const right = await open(directory);
    const results = await Promise.allSettled([left.reserve(request()), right.reserve(request({ idempotency_key: key(2), operation: "create_evidence_volume" }))]);
    expect(results.filter((value) => value.status === "fulfilled" && value.value.kind === "owner")).toHaveLength(1);
    expect(results.filter((value) => value.status === "rejected")).toHaveLength(1);
    expect((await left.read()).entries).toHaveLength(1);
  });

  it("recovers exact pending work after a crash-created empty lock without double ownership", async () => {
    const directory = await root(); const first = await open(directory); const file = await recordPath(directory); await writeFile(`${file}.lock`, "", "utf8");
    const second = await open(directory); const results = await Promise.all([first.reserve(request()), second.reserve(request())]);
    expect(results.map((value) => value.kind).sort()).toEqual(["owner", "pending"]);
    const claimed = results.find((value) => value.kind === "owner"); if (!claimed || claimed.kind !== "owner") return;
    const recovery = request({ idempotency_key: key(3), operation: "recover_operation", operation_handle: claimed.claim.operationHandle });
    await expect(first.reserve(recovery)).resolves.toEqual({ kind: "pending", claim: claimed.claim });
    await failed(first.reserve({ ...recovery, operation_handle: handle(99) }));
  });

  it("rejects corrupted canonical stored receipts and every stored receipt correlation drift", async () => {
    for (const mutate of [
      (stored: any) => { stored.claims[0].receipt_bytes += " "; },
      (stored: any) => { const value = JSON.parse(stored.claims[0].receipt_bytes); value.run_id = "other-run"; stored.claims[0].receipt_bytes = JSON.stringify(value); },
      (stored: any) => { const value = JSON.parse(stored.claims[0].receipt_bytes); value.selected_target.fingerprint = `sha256:${"0".repeat(32)}`; value.receipt_digest = createTargetReceiptDigest(value); stored.claims[0].receipt_bytes = JSON.stringify(value); stored.journal.entries[0].receipt_digest = value.receipt_digest; },
      (stored: any) => { const value = JSON.parse(stored.claims[0].receipt_bytes); value.descriptor_digest = `sha256:${"0".repeat(64)}`; value.receipt_digest = createTargetReceiptDigest(value); stored.claims[0].receipt_bytes = JSON.stringify(value); stored.journal.entries[0].receipt_digest = value.receipt_digest; },
      (stored: any) => { const value = JSON.parse(stored.claims[0].receipt_bytes); value.operation_handle = handle(88); value.receipt_digest = createTargetReceiptDigest(value); stored.claims[0].receipt_bytes = JSON.stringify(value); stored.journal.entries[0].receipt_digest = value.receipt_digest; }
    ]) {
      const directory = await root(); const journal = await open(directory); await complete(journal, request()); const file = await recordPath(directory); const stored = JSON.parse(await readFile(file, "utf8")); mutate(stored); await writeFile(file, JSON.stringify(stored), "utf8"); await failed(journal.read()); await failed(journal.reserve(request()));
    }
  });

  it("enforces typed target provenance but accepts opaque externally owned handoff and sources", async () => {
    const journal = await open(); const network = handle(10); await complete(journal, request(), { result_handle: network });
    await failed(journal.reserve(request({ expected_revision: 1, idempotency_key: key(2), operation: "start_world_service", world_service_handle: network })));
    const attachment = await complete(journal, request({ expected_revision: 1, idempotency_key: key(3), operation: "attach_organization", data_network_handle: network, organization_handoff_handle: handle(11) }), { result_handle: handle(12) });
    const prepared = await journal.reserve(request({ expected_revision: 2, idempotency_key: key(4), operation: "prepare_secret_bindings", bindings: [{ name: "world", scope: "runtime", source_handle: handle(13) }] }));
    expect(prepared.kind).toBe("owner"); if (prepared.kind !== "owner") return;
    await journal.complete(prepared.claim, receipt(prepared.claim, 3, { operation: "prepare_secret_bindings", result_handle: handle(14) }));
    expect(attachment).toBeDefined();
  });

  it("rejects duplicate or ambiguous completed result provenance", async () => {
    const journal = await open(); const shared = handle(20); await complete(journal, request(), { result_handle: shared });
    await complete(journal, request({ expected_revision: 1, idempotency_key: key(2), operation: "create_evidence_volume" }), { result_handle: shared });
    await failed(journal.reserve(request({ expected_revision: 2, idempotency_key: key(3), operation: "export_evidence_volume", evidence_volume_handle: shared })));
  });

  it("rejects hostile completion correlations before recording completion", async () => {
    const journal = await open(); const claimed = await journal.reserve(request());
    expect(claimed.kind).toBe("owner"); if (claimed.kind !== "owner") return;
    for (const changes of [
      { operation_handle: handle(88) },
      { resulting_revision: 2 },
      { request_digest: `sha256:${"0".repeat(64)}` },
      { selected_target: { ...target, fingerprint: `sha256:${"0".repeat(32)}` } }
    ]) await failed(journal.complete(claimed.claim, receipt(claimed.claim, 1, changes)));
    expect((await journal.read()).entries).toMatchObject([{ state: "pending" }]);
  });

  it("validates prospective bytes, supports 128 complete entries, and rejects 129 without changing them", async () => {
    const directory = await root(); const journal = await open(directory);
    for (let index = 0; index < 128; index += 1) await complete(journal, request({ expected_revision: index, idempotency_key: key(index + 1) }), { result_handle: handle(index + 1) });
    const file = await recordPath(directory); const before = await readFile(file, "utf8"); await failed(journal.reserve(request({ expected_revision: 128, idempotency_key: key(129) })));
    expect(await readFile(file, "utf8")).toBe(before); expect((await journal.read()).entries).toHaveLength(128);
  }, 120_000);

  it("rejects symlink ancestors before creating a journal and malformed private state", async () => {
    const base = await root(); const outside = await root(); await symlink(outside, path.join(base, "escape"));
    await failed(open(path.join(base, "escape", "nested"))); expect(await readdir(outside)).toEqual([]);
    for (const mutate of [async (file: string) => writeFile(file, "{", "utf8"), async (file: string) => writeFile(file, '{"unknown":"sentinel"}', "utf8"), async (file: string) => writeFile(file, "x".repeat(524_289), "utf8")]) {
      const directory = await root(); const journal = await open(directory); await mutate(await recordPath(directory)); await failed(journal.read());
    }
    const directory = await root(); const journal = await open(directory); const file = await recordPath(directory); await rm(file); await symlink(path.join(directory, "sentinel"), file); await failed(journal.read()); await rm(file); await mkdir(file, { mode: 0o700 }); await failed(journal.read());
  });

  it("attempts a directory sync after replacements through an observable filesystem seam", async () => {
    let syncs = 0; const restore = setTargetJournalFilesystemForTests({ syncDirectory: async () => { syncs += 1; } });
    try { const journal = await open(); const claimed = await owner(journal, request()); await journal.complete(claimed, receipt(claimed, 1)); expect(syncs).toBeGreaterThanOrEqual(2); }
    finally { restore(); }
  });

  it("looks up exact pending and completed mutations without changing journal state", async () => {
    const directory = await root(); const journal = await open(directory);
    const original = request(); const claim = await owner(journal, original);
    const file = await recordPath(directory); const pendingBytes = await readFile(file, "utf8");
    const pendingStats = await lstat(file); const pendingEntries = await readdir(directory);
    const pending = await lookupTargetOperation({
      context: "production", request: original, root: directory
    });
    expect(pending).toEqual({
      idempotency_key: original.idempotency_key,
      operation: original.operation,
      operation_handle: claim.operationHandle,
      request_digest: createTargetRequestDigest(original),
      status: "pending",
      version: "spawnfile.target-resource.operation-lookup.v1"
    });
    expect(createCanonicalTargetOperationLookupBytes(
      await lookupTargetOperation({ context: "production", request: original, root: directory })
    )).toBe(createCanonicalTargetOperationLookupBytes(pending));
    expect(await readFile(file, "utf8")).toBe(pendingBytes);
    expect((await lstat(file)).mtimeMs).toBe(pendingStats.mtimeMs);
    expect(await readdir(directory)).toEqual(pendingEntries);

    const done = await journal.complete(claim, receipt(claim, 1));
    const completedBytes = await readFile(file, "utf8"); const completedStats = await lstat(file);
    const completed = await (await openExistingTargetJournal({
      context: "production", descriptorDigest: digest, root: directory,
      runId: "run-one", selectedTarget: selected
    })).lookup(original);
    expect(completed).toMatchObject({
      idempotency_key: original.idempotency_key,
      operation_handle: claim.operationHandle,
      receipt: done.receipt,
      request_digest: claim.requestDigest,
      status: "completed"
    });
    expect(await readFile(file, "utf8")).toBe(completedBytes);
    expect((await lstat(file)).mtimeMs).toBe(completedStats.mtimeMs);
    expect(await readdir(directory)).toEqual(pendingEntries);

    const lookupOnly = await openExistingTargetJournal({
      context: "production", descriptorDigest: digest, root: directory,
      runId: "run-one", selectedTarget: selected
    });
    expect(Object.keys(lookupOnly)).toEqual(["lookup"]);
    expect(Object.isFrozen(lookupOnly)).toBe(true);
    for (const forbidden of [
      "complete", "read", "reserve", "resolveCompletedReceipt", "withLifecycleLease"
    ]) expect(forbidden in lookupOnly).toBe(false);
  });

  it("returns not_applied without creating state and fails closed on drift or selection", async () => {
    const base = await root(); const missing = path.join(base, "missing");
    await expect(lookupTargetOperation({
      context: "production", request: request(), root: missing
    })).resolves.toMatchObject({ status: "not_applied" });
    await expect(lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });

    const directory = await root(); const journal = await open(directory);
    await owner(journal, request());
    await failed(lookupTargetOperation({
      context: "production",
      request: request({ operation: "create_evidence_volume" }),
      root: directory
    }));
    await failed(lookupTargetOperation({
      context: "production",
      request: {
        idempotency_key: key(8), operation: "select_target",
        target_reference: "production", version: TARGET_RESOURCE_REQUEST_VERSION
      },
      root: directory
    }));
    await expect(lookupTargetOperation({
      context: "production", request: request({ idempotency_key: key(9) }), root: directory
    })).resolves.toMatchObject({
      idempotency_key: key(9), operation: "create_data_network",
      status: "not_applied"
    });
  });

  it("fails closed on unsafe existing root and journal metadata", async () => {
    const wrongRoot = await root(); await chmod(wrongRoot, 0o755);
    await failed(lookupTargetOperation({
      context: "production", request: request(), root: wrongRoot
    }));

    const wrongMode = await root(); await open(wrongMode);
    const modeFile = await recordPath(wrongMode); await chmod(modeFile, 0o644);
    await failed(lookupTargetOperation({
      context: "production", request: request(), root: wrongMode
    }));

    const linked = await root(); await open(linked);
    const linkedFile = await recordPath(linked);
    await link(linkedFile, path.join(linked, "duplicate"));
    await failed(lookupTargetOperation({
      context: "production", request: request(), root: linked
    }));
  });

  it("rejects a canonically valid stored completion at the wrong requested revision", async () => {
    const directory = await root(); const journal = await open(directory);
    await complete(journal, request());
    const file = await recordPath(directory);
    const stored = JSON.parse(await readFile(file, "utf8"));
    const driftedRequest = request({ expected_revision: 7 });
    const requestDigest = createTargetRequestDigest(driftedRequest);
    const completedReceipt = JSON.parse(stored.claims[0].receipt_bytes);
    completedReceipt.request_digest = requestDigest;
    completedReceipt.receipt_digest = createTargetReceiptDigest(completedReceipt);
    stored.claims[0].request_digest = requestDigest;
    stored.claims[0].receipt_bytes = JSON.stringify(completedReceipt);
    stored.journal.entries[0].request_digest = requestDigest;
    stored.journal.entries[0].receipt_digest = completedReceipt.receipt_digest;
    await writeFile(file, JSON.stringify(stored), "utf8");
    await expect(journal.read()).resolves.toMatchObject({ revision: 1 });
    await failed(lookupTargetOperation({
      context: "production", request: driftedRequest, root: directory
    }));
  });
});
