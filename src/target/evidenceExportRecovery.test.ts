import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isEvidenceExportIncomplete } from "./evidenceExport.js";
import { cleanupTestRoots, runLifecycleExport } from "./evidenceExportOperationsTestKit.js";

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
};

afterEach(cleanupTestRoots);

describe("evidence export exact recovery", () => {
  it("rebuilds one exact published pending export and completes its original claim", async () => {
    let failOnce = true;
    const fixture = await runLifecycleExport({ boundaryFailures: { beforeJournalComplete: () => { if (failOnce) { failOnce = false; throw new Error("crash before completion"); } } } });
    await expect(fixture.execute()).rejects.toThrow("Evidence-volume export failed");
    expect(await fixture.readJournalRevision()).toBe(2);
    expect(fixture.getExportCalls()).toBe(1);
    const destination = path.join(fixture.directory, "match.tar");
    const published = await readFile(destination);

    const result = await fixture.recover() as { readonly receipt: { readonly operation: string; readonly resulting_revision: number } };
    expect(result.receipt.operation).toBe("export_evidence_volume");
    expect(result.receipt.resulting_revision).toBe(3);
    expect(await fixture.readJournalRevision()).toBe(3);
    expect(fixture.getExportCalls()).toBe(2);
    expect(await readFile(destination)).toEqual(published);
    expect(fixture.calls.some((args) => args.includes("ls") || args.includes("list") || args.includes("--all"))).toBe(false);
  });

  it("rejects a destination outside the exact stored commitment before Docker recovery", async () => {
    let failOnce = true;
    const fixture = await runLifecycleExport({ boundaryFailures: { beforeJournalComplete: () => { if (failOnce) { failOnce = false; throw new Error("crash before completion"); } } } });
    await expect(fixture.execute()).rejects.toThrow("Evidence-volume export failed");
    const calls = fixture.calls.length;
    const exports = fixture.getExportCalls();
    await expect(fixture.recover(path.join(fixture.directory, "wrong.tar"))).rejects.toThrow("Evidence-volume export failed");
    expect(fixture.calls).toHaveLength(calls);
    expect(fixture.getExportCalls()).toBe(exports);
    expect(await fixture.readJournalRevision()).toBe(2);
  });

  it("clears only a proven-dead exact claim before a later recovery elects an owner", async () => {
    let failOnce = true;
    const fixture = await runLifecycleExport({ createDestinationStoreOptions: { isProcessAlive: () => false }, boundaryFailures: { beforeJournalComplete: () => { if (failOnce) { failOnce = false; throw new Error("crash before completion"); } } } });
    await expect(fixture.execute()).rejects.toThrow("Evidence-volume export failed");
    await fixture.seedStaleExportClaim();
    const calls = fixture.calls.length;
    const exports = fixture.getExportCalls();
    await expect(fixture.recover()).rejects.toSatisfy((error: unknown) => isEvidenceExportIncomplete(error));
    expect(fixture.calls).toHaveLength(calls);
    expect(fixture.getExportCalls()).toBe(exports);
    await expect(fixture.recover()).resolves.toMatchObject({ receipt: { operation: "export_evidence_volume", resulting_revision: 3 } });
    expect(await fixture.readJournalRevision()).toBe(3);
  });

  it("reconstructs and publishes the missing index for one exact admitted pending export", async () => {
    let failOnce = true;
    const fixture = await runLifecycleExport({ boundaryFailures: { beforeIndexBind: () => { if (failOnce) { failOnce = false; throw new Error("crash before index"); } } } });
    await expect(fixture.execute()).rejects.toThrow("Evidence-volume export failed");
    await expect(fixture.recover()).resolves.toMatchObject({ receipt: { operation: "export_evidence_volume", resulting_revision: 3 } });
    expect(await fixture.readJournalRevision()).toBe(3);
    expect(fixture.getExportCalls()).toBe(2);
  });

  it.each(["missing", "malformed"] as const)("fails closed for a %s exact admission before Docker recovery", async (kind) => {
    let failOnce = true;
    const fixture = await runLifecycleExport({ boundaryFailures: { beforeJournalComplete: () => { if (failOnce) { failOnce = false; throw new Error("crash before completion"); } } } });
    await expect(fixture.execute()).rejects.toThrow("Evidence-volume export failed");
    const admission = (await readdir(fixture.getExportStorePath())).find((file) => file.endsWith(".admission.json"));
    if (!admission) throw new Error("admission missing");
    const admissionPath = path.join(fixture.getExportStorePath(), admission);
    if (kind === "missing") await unlink(admissionPath); else await writeFile(admissionPath, "{", "utf8");
    const calls = fixture.calls.length;
    const exports = fixture.getExportCalls();
    await expect(fixture.recover()).rejects.toThrow("Evidence-volume export failed");
    expect(fixture.calls).toHaveLength(calls);
    expect(fixture.getExportCalls()).toBe(exports);
    expect(await fixture.readJournalRevision()).toBe(2);
  });

  it.each(["volume", "helper", "binding"] as const)("rejects %s recovery authority drift without archive or completion", async (kind) => {
    let failOnce = true;
    const fixture = await runLifecycleExport({ boundaryFailures: { beforeJournalComplete: () => { if (failOnce) { failOnce = false; throw new Error("crash before completion"); } } } });
    await expect(fixture.execute()).rejects.toThrow("Evidence-volume export failed");
    if (kind === "volume") fixture.setVolumeInspectionDrift(true);
    if (kind === "helper") fixture.setHelperInspectionDrift(true);
    if (kind === "binding") {
      const binding = (await readdir(path.join(fixture.directory, "identities"))).find((file) => file.endsWith(".json"));
      if (!binding) throw new Error("identity binding missing");
      const bindingPath = path.join(fixture.directory, "identities", binding);
      const value = JSON.parse(await readFile(bindingPath, "utf8")) as Record<string, unknown>;
      value.artifact_manifest_digest = `sha256:${"d".repeat(64)}`;
      await writeFile(bindingPath, JSON.stringify(value), "utf8");
    }
    const calls = fixture.calls.length;
    const exports = fixture.getExportCalls();
    await expect(fixture.recover()).rejects.toThrow("Evidence-volume export failed");
    if (kind === "binding") expect(fixture.calls).toHaveLength(calls);
    expect(fixture.getExportCalls()).toBe(exports);
    expect(await fixture.readJournalRevision()).toBe(2);
  });

  it("returns incomplete without Docker for a live exact private claim", async () => {
    let failOnce = true;
    const fixture = await runLifecycleExport({ boundaryFailures: { beforeJournalComplete: () => { if (failOnce) { failOnce = false; throw new Error("crash before completion"); } } } });
    await expect(fixture.execute()).rejects.toThrow("Evidence-volume export failed");
    await fixture.seedStaleExportClaim();
    const calls = fixture.calls.length;
    const exports = fixture.getExportCalls();
    await expect(fixture.recover()).rejects.toSatisfy((error: unknown) => isEvidenceExportIncomplete(error));
    expect(fixture.calls).toHaveLength(calls);
    expect(fixture.getExportCalls()).toBe(exports);
    expect(await fixture.readJournalRevision()).toBe(2);
  });

  it("clears pending-only claims and tombstone races without electing or running Docker", async () => {
    const pending = deferred();
    const releasePending = deferred();
    let failOnce = true;
    let claimCreates = 0;
    const pendingOnly = await runLifecycleExport({ createDestinationStoreOptions: { isProcessAlive: () => false, afterClaimPendingCreated: async () => { claimCreates += 1; if (claimCreates === 1) return; pending.resolve(); await releasePending.promise; } }, boundaryFailures: { beforeJournalComplete: () => { if (failOnce) { failOnce = false; throw new Error("crash before completion"); } } } });
    await expect(pendingOnly.execute()).rejects.toThrow("Evidence-volume export failed");
    const seeding = pendingOnly.seedStaleExportClaim();
    await pending.promise;
    const pendingCalls = pendingOnly.calls.length;
    await expect(pendingOnly.recover()).rejects.toSatisfy((error: unknown) => isEvidenceExportIncomplete(error));
    expect(pendingOnly.calls).toHaveLength(pendingCalls);
    releasePending.resolve();
    await expect(seeding).rejects.toThrow("export claim unavailable");

    const linked = deferred();
    const releaseTombstone = deferred();
    let tombstoneFailure = true;
    const tombstone = await runLifecycleExport({ createDestinationStoreOptions: { isProcessAlive: () => false, afterRecoveryTombstoneLinked: async () => { linked.resolve(); await releaseTombstone.promise; } }, boundaryFailures: { beforeJournalComplete: () => { if (tombstoneFailure) { tombstoneFailure = false; throw new Error("crash before completion"); } } } });
    await expect(tombstone.execute()).rejects.toThrow("Evidence-volume export failed");
    await tombstone.seedStaleExportClaim();
    const first = tombstone.recover();
    await linked.promise;
    const tombstoneCalls = tombstone.calls.length;
    await expect(tombstone.recoverPeer()).rejects.toSatisfy((error: unknown) => isEvidenceExportIncomplete(error));
    expect(tombstone.calls).toHaveLength(tombstoneCalls);
    releaseTombstone.resolve();
    await expect(first).rejects.toSatisfy((error: unknown) => isEvidenceExportIncomplete(error));
  });

  it("rejects malformed canonical output and retains a mismatched regular destination without clobbering", async () => {
    const malformed = await runLifecycleExport({ payload: new Uint8Array([1]) });
    await expect(malformed.execute()).rejects.toThrow("Evidence-volume export failed");
    await expect(malformed.recover()).rejects.toThrow("Evidence-volume export failed");
    expect(await malformed.readJournalRevision()).toBe(2);

    let failOnce = true;
    const fixture = await runLifecycleExport({ boundaryFailures: { beforeJournalComplete: () => { if (failOnce) { failOnce = false; throw new Error("crash before completion"); } } } });
    await expect(fixture.execute()).rejects.toThrow("Evidence-volume export failed");
    const destination = path.join(fixture.directory, "match.tar");
    await writeFile(destination, "mismatch", "utf8");
    await expect(fixture.recover()).rejects.toThrow("Evidence-volume export failed");
    expect(await readFile(destination, "utf8")).toBe("mismatch");
    expect(await fixture.readJournalRevision()).toBe(2);
  });
});
