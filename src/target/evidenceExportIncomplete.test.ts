import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isEvidenceExportIncomplete } from "./evidenceExport.js";
import { cleanupTestRoots, runLifecycleExport } from "./evidenceExportOperationsTestKit.js";

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
};

const privateSnapshot = async (root: string): Promise<Readonly<Record<string, string>>> => {
  const entries = await readdir(root);
  return Object.fromEntries(await Promise.all(entries.sort().map(async (name) => [name, (await readFile(path.join(root, name))).toString("base64")])));
};

afterEach(cleanupTestRoots);

describe("evidence export incomplete outcomes", () => {
  it("returns only internal incomplete for a normal journal pending claim without effects", async () => {
    let failOnce = true;
    const fixture = await runLifecycleExport({ boundaryFailures: { beforeBindAdmission: () => { if (failOnce) { failOnce = false; throw new Error("owner stopped"); } } } });
    await expect(fixture.execute()).rejects.toThrow("Evidence-volume export failed");
    const files = await privateSnapshot(fixture.getExportStorePath());
    const calls = fixture.calls.length;
    const exports = fixture.getExportCalls();
    const revision = await fixture.readJournalRevision();

    await expect(fixture.execute()).rejects.toSatisfy((error: unknown) => isEvidenceExportIncomplete(error));
    expect(fixture.calls).toHaveLength(calls);
    expect(fixture.getExportCalls()).toBe(exports);
    expect(await fixture.readJournalRevision()).toBe(revision);
    expect(await privateSnapshot(fixture.getExportStorePath())).toEqual(files);
  });

  it("returns internal incomplete before Docker when recovery clears stale or observes live exact claims", async () => {
    let staleFailure = true;
    const stale = await runLifecycleExport({ createDestinationStoreOptions: { isProcessAlive: () => false }, boundaryFailures: { beforeJournalComplete: () => { if (staleFailure) { staleFailure = false; throw new Error("crash"); } } } });
    await expect(stale.execute()).rejects.toThrow("Evidence-volume export failed");
    await stale.seedStaleExportClaim();
    const staleCalls = stale.calls.length;
    const staleExports = stale.getExportCalls();
    const staleRevision = await stale.readJournalRevision();
    await expect(stale.recover()).rejects.toSatisfy((error: unknown) => isEvidenceExportIncomplete(error));
    expect(stale.calls).toHaveLength(staleCalls);
    expect(stale.getExportCalls()).toBe(staleExports);
    expect(await stale.readJournalRevision()).toBe(staleRevision);
    await expect(stale.recover()).resolves.toMatchObject({ receipt: { resulting_revision: 3 } });
    expect(stale.getExportCalls()).toBe(staleExports + 1);
    expect(await stale.readJournalRevision()).toBe(3);

    let liveFailure = true;
    const live = await runLifecycleExport({ boundaryFailures: { beforeJournalComplete: () => { if (liveFailure) { liveFailure = false; throw new Error("crash"); } } } });
    await expect(live.execute()).rejects.toThrow("Evidence-volume export failed");
    await live.seedStaleExportClaim();
    const liveCalls = live.calls.length;
    const liveExports = live.getExportCalls();
    const liveRevision = await live.readJournalRevision();
    const liveState = await privateSnapshot(live.getExportStorePath());
    await expect(live.recover()).rejects.toSatisfy((error: unknown) => isEvidenceExportIncomplete(error));
    expect(live.calls).toHaveLength(liveCalls);
    expect(live.getExportCalls()).toBe(liveExports);
    expect(await live.readJournalRevision()).toBe(liveRevision);
    expect(await privateSnapshot(live.getExportStorePath())).toEqual(liveState);
  });

  it("coalesces identical in-process calls and rejects conflicting destination or request bodies without effects", async () => {
    const entered = deferred();
    const release = deferred();
    const fixture = await runLifecycleExport({ boundaryFailures: { beforeArchive: async () => { entered.resolve(); await release.promise; } } });
    const first = fixture.execute();
    await entered.promise;
    const calls = fixture.calls.length;
    const exports = fixture.getExportCalls();
    const revision = await fixture.readJournalRevision();
    const privateState = await privateSnapshot(fixture.getExportStorePath());
    const identical = fixture.execute();
    await expect(fixture.execute(path.join(fixture.directory, "conflict.tar"))).rejects.toThrow("Evidence-volume export failed");
    await expect(fixture.executeDistinct()).rejects.toThrow("Evidence-volume export failed");
    expect(fixture.calls).toHaveLength(calls);
    expect(fixture.getExportCalls()).toBe(exports);
    expect(await fixture.readJournalRevision()).toBe(revision);
    expect(await privateSnapshot(fixture.getExportStorePath())).toEqual(privateState);
    release.resolve();
    await expect(Promise.all([first, identical])).resolves.toHaveLength(2);
    expect(fixture.getExportCalls()).toBe(1);
    expect(await fixture.readJournalRevision()).toBe(3);
  });

  it("coalesces identical in-process recoveries and rejects conflicting destination or request bodies without effects", async () => {
    const entered = deferred();
    const release = deferred();
    let archiveCalls = 0;
    let failOnce = true;
    const fixture = await runLifecycleExport({
      boundaryFailures: {
        beforeArchive: async () => {
          archiveCalls += 1;
          if (archiveCalls === 1) return;
          entered.resolve();
          await release.promise;
        },
        beforeJournalComplete: () => {
          if (failOnce) {
            failOnce = false;
            throw new Error("owner stopped");
          }
        }
      }
    });
    await expect(fixture.execute()).rejects.toThrow("Evidence-volume export failed");
    const first = fixture.recover();
    await entered.promise;
    const calls = fixture.calls.length;
    const exports = fixture.getExportCalls();
    const revision = await fixture.readJournalRevision();
    const privateState = await privateSnapshot(fixture.getExportStorePath());
    const identical = fixture.recover();
    await expect(fixture.recover(path.join(fixture.directory, "conflict.tar"))).rejects.toThrow("Evidence-volume export failed");
    await expect(fixture.recoverDistinct()).rejects.toThrow("Evidence-volume export failed");
    expect(fixture.calls).toHaveLength(calls);
    expect(fixture.getExportCalls()).toBe(exports);
    expect(await fixture.readJournalRevision()).toBe(revision);
    expect(await privateSnapshot(fixture.getExportStorePath())).toEqual(privateState);
    release.resolve();
    await expect(Promise.all([first, identical])).resolves.toHaveLength(2);
    expect(fixture.getExportCalls()).toBe(2);
    expect(await fixture.readJournalRevision()).toBe(3);
  });
});
