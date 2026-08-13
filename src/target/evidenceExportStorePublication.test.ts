import {
  chmod,
  lstat,
  link,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseOpaqueTargetHandle } from "./contracts.js";
import { createDockerResourceSpec } from "./dockerResourcesProvider.js";
import { EVIDENCE_EXPORT_HELPER_CONTRACT, createEvidenceExportHelper, parseEvidenceVolumeAuthority } from "./evidenceExportProvider.js";
import { destinationKey, publishImmutable } from "./evidenceExportStorePublication.js";
import { initializeEvidenceExportAuthorityStore, type EvidenceExportAdmission } from "./evidenceExportStore.js";

const roots: string[] = [];
const root = async (): Promise<string> => {
  const value = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-export-store-publication-")));
  roots.push(value);
  return value;
};

afterEach(async () => Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true }))));

const admission = (): EvidenceExportAdmission => {
  const selected = parseOpaqueTargetHandle("opaque_dddddddddddddddd");
  const volume = createDockerResourceSpec({
    kind: "evidence_volume",
    operationHandle: parseOpaqueTargetHandle("opaque_eeeeeeeeeeeeeeee"),
    requestDigest: `sha256:${"f".repeat(64)}`,
    runId: "run-one",
    selectedTargetHandle: selected,
  });

  return {
    descriptor_digest: `sha256:${"a".repeat(64)}`,
    evidence_volume: parseEvidenceVolumeAuthority({ labels: volume.labels, name: volume.name, resultHandle: volume.resultHandle }),
    helper: createEvidenceExportHelper({
      artifactManifestDigest: `sha256:${"b".repeat(64)}`,
      imageDigest: `sha256:${"c".repeat(64)}`,
      imageReference: `registry.example/export@sha256:${"c".repeat(64)}`,
      resultHandle: parseOpaqueTargetHandle("opaque_bbbbbbbbbbbbbbbb"),
    }),
    helper_contract: EVIDENCE_EXPORT_HELPER_CONTRACT,
    operation_handle: parseOpaqueTargetHandle("opaque_cccccccccccccccc"),
    request_digest: `sha256:${"d".repeat(64)}`,
    run_id: "run-one",
    selected_target: { fingerprint: `sha256:${"e".repeat(32)}`, handle: selected },
    version: "spawnfile.target-evidence-export.private.v1",
  };
};

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
};

describe("evidence export destination publication", () => {
  it("retries immutable publication from transient final nlink2 and converges", async () => {
    const directory = await root();
    const release = deferred();
    const seen = deferred();

    const writer = publishImmutable(directory, "immutable.json", "{\"a\":1}", false, {
      afterImmutableFinalLinkBeforeTempUnlink: async () => {
        seen.resolve();
        await release.promise;
      },
    });

    await seen.promise;
    const reader = publishImmutable(directory, "immutable.json", "{\"a\":1}", true);
    const snapshot = await lstat(path.join(directory, "immutable.json"));
    expect(snapshot.nlink).toBe(2);

    release.resolve();
    await Promise.all([writer, reader]);
    expect((await lstat(path.join(directory, "immutable.json"))).nlink).toBe(1);
  });

  it("invokes immutable transient hook on stable nlink2 and converges", async () => {
    const directory = await root();
    const staged = path.join(directory, ".immutable.staging");
    const final = path.join(directory, "immutable.json");
    let transientCount = 0;

    await writeFile(staged, "{\"b\":2}", "utf8");
    await chmod(staged, 0o600);
    await link(staged, final);

    await publishImmutable(directory, "immutable.json", "{\"b\":2}", true, {
      afterImmutableTransientRead: async () => {
        transientCount += 1;
        await unlink(staged);
      },
    });
    expect(transientCount).toBe(1);
    expect((await lstat(final)).nlink).toBe(1);
  });

  it("stabilizes after loser pause in destination publication and no pending residue remains", async () => {
    const directory = await root();
    const value = admission();
    const destination = "/operator/private/stable-destination.tar";
    const pause = deferred();
    const resume = deferred();

    const loser = await initializeEvidenceExportAuthorityStore(directory, {
      beforeDestinationKeyLink: async () => {
        pause.resolve();
        await resume.promise;
      },
    });
    await loser.bindAdmission(value);

    const loserWork = loser.bindDestination(value, destination);
    await pause.promise;

    const winner = await initializeEvidenceExportAuthorityStore(directory);
    await winner.bindAdmission(value);
    const winnerWork = winner.bindDestination(value, destination);

    resume.resolve();
    await Promise.all([loserWork, winnerWork]);
    await winner.requireDestination(value, destination);
    await loser.requireDestination(value, destination);

    expect(await readFile(path.join(directory, ".destination-hmac.key"), "utf8")).toMatch(/^[0-9a-f]{64}$/u);
    expect(await readdir(directory)).toEqual(expect.not.arrayContaining([expect.stringContaining(".tmp") ]));
  });

  it("rejects hostile pending-only nlink3 without mutating the hostile generation", async () => {
    const directory = await root();
    const value = admission();
    const destination = "/operator/private/pending-only-nlink3.tar";
    const store = await initializeEvidenceExportAuthorityStore(directory);
    await store.bindAdmission(value);

    const temporary = path.join(directory, ".destination-hmac.hostile-tmp");
    const pending = path.join(directory, ".destination-hmac.pending");
    const peerA = path.join(directory, ".destination-hmac.peer-a");
    const peerB = path.join(directory, ".destination-hmac.peer-b");

    await writeFile(temporary, `${"0".repeat(63)}1`, "utf8");
    await chmod(temporary, 0o600);
    await link(temporary, pending);
    await link(pending, peerA);
    await link(pending, peerB);
    await unlink(temporary);

    const before = await Promise.all([lstat(pending), lstat(peerA), lstat(peerB)]);
    await expect(store.bindDestination(value, destination)).rejects.toThrow("Evidence-volume export failed");
    const after = await Promise.all([lstat(pending), lstat(peerA), lstat(peerB)]);
    before.forEach((snapshot, index) => {
      expect(after[index].ino).toBe(snapshot.ino);
      expect(after[index].dev).toBe(snapshot.dev);
      expect(after[index].nlink).toBe(3);
    });
    await expect(lstat(path.join(directory, ".destination-hmac.key"))).rejects.toThrow();
    expect((await readdir(directory)).filter((file) => file.includes(".tmp")).length).toBe(0);
  });

  it("rejects malformed final immutably and leaves destination state for correction", async () => {
    const directory = await root();
    const value = admission();
    const destination = "/operator/private/malformed-final.tar";
    const store = await initializeEvidenceExportAuthorityStore(directory);

    await store.bindAdmission(value);
    await store.bindDestination(value, destination);

    const keyFile = path.join(directory, ".destination-hmac.key");
    const original = await readFile(keyFile, "utf8");
    await writeFile(keyFile, "not-a-valid-key", "utf8");

    await expect(store.requireDestination(value, destination)).rejects.toThrow("Evidence-volume export failed");
    expect(await readFile(keyFile, "utf8")).toBe("not-a-valid-key");

    await writeFile(keyFile, original, "utf8");
    await expect(destinationKey(directory)).resolves.toEqual(Buffer.from(original, "hex"));
  });

  it("bypasses the cleanup pending-read hook and converges after foreign final insertion", async () => {
    const directory = await root();
    const final = path.join(directory, ".destination-hmac.key");
    let pendingLstatCalls = 0;

    const outcome = destinationKey(directory, {
      afterDestinationKeyInitialFinalAbsent: async () => {
        await writeFile(final, `${"c".repeat(64)}`, "utf8");
        await chmod(final, 0o600);
      },
      afterDestinationKeyPendingLstatBeforeOpen: async () => {
        pendingLstatCalls += 1;
      },
    });

    await expect(outcome).resolves.toEqual(Buffer.from(`${"c".repeat(64)}`, "hex"));
    expect(pendingLstatCalls).toBe(0);
  });

  it("coordinates K1/K2 publication with a third reader through convergent final delivery", async () => {
    const directory = await root();
    const finalPath = path.join(directory, ".destination-hmac.key");
    const pendingPath = path.join(directory, ".destination-hmac.pending");
    const loserPause = deferred();
    const loserResume = deferred();
    const loserPendingPause = deferred();
    const loserPendingResume = deferred();
    const firstReaderPass = deferred<{
      final: Awaited<ReturnType<typeof lstat>>;
      pending: Awaited<ReturnType<typeof lstat>>;
      finalBytes: string;
      pendingBytes: string;
    }>();
    const secondReaderPass = deferred();
    const readerResume = deferred();

    let winnerValue = "";
    let loserPendingBytes = "";
    let loserPendingIno = -1;
    let readerSnapshots = 0;

    const loser = destinationKey(directory, {
      afterDestinationKeyInitialFinalAbsent: async () => {
        loserPause.resolve();
        await loserResume.promise;
      },
      afterDestinationKeyPendingLinkBeforeTempUnlink: async () => {
        const snapshot = await lstat(pendingPath);
        loserPendingBytes = await readFile(pendingPath, "utf8");
        loserPendingIno = snapshot.ino;
        loserPendingPause.resolve();
        await loserPendingResume.promise;
      },
    });

    await loserPause.promise;
    const winner = destinationKey(directory);
    const winnerValueBuffer = await winner;
    winnerValue = winnerValueBuffer.toString("hex");
    loserResume.resolve();

    await loserPendingPause.promise;
    const reader = destinationKey(directory, {
      afterDestinationKeyFinalSnapshot: async () => {
        readerSnapshots += 1;
        if (readerSnapshots === 1) {
          const snapshot = await lstat(finalPath);
          const pendingSnapshot = await lstat(pendingPath);
          const finalBytes = await readFile(finalPath, "utf8");
          const pendingBytes = await readFile(pendingPath, "utf8");
          firstReaderPass.resolve({ final: snapshot, pending: pendingSnapshot, finalBytes, pendingBytes });
        } else if (readerSnapshots === 2) {
          secondReaderPass.resolve();
          await readerResume.promise;
        }
      },
    });

    const first = await firstReaderPass.promise;
    expect(await readFile(pendingPath, "utf8")).toBe(loserPendingBytes);
    expect(first.pendingBytes).toBe(loserPendingBytes);
    expect(first.finalBytes).toBe(winnerValue);
    expect(first.pendingBytes).not.toBe(first.finalBytes);
    expect(first.final.ino).not.toBe(first.pending.ino);
    expect(first.pending.ino).toBe(loserPendingIno);
    expect(first.pending.nlink).toBe(2);
    await secondReaderPass.promise;
    loserPendingResume.resolve();
    const loserValue = await loser;
    readerResume.resolve();
    const readerValue = await reader;
    expect(winnerValueBuffer.equals(loserValue)).toBe(true);
    expect(readerValue.equals(loserValue)).toBe(true);
    const final = await lstat(finalPath);
    expect(final.nlink).toBe(1);
    expect((await readFile(finalPath, "utf8"))).toBe(winnerValue);
    expect((await readFile(finalPath, "utf8"))).not.toBe(loserPendingBytes);
    expect(first.final.nlink).toBe(1);
    expect(readerSnapshots).toBeGreaterThanOrEqual(1);
    await expect(lstat(pendingPath)).rejects.toThrow();
  });

  it("retries destination-key publication from authentic stale nlink3 and reader-observed cleanup", async () => {
    const directory = await root();
    const finalPath = path.join(directory, ".destination-hmac.key");
    const pendingPath = path.join(directory, ".destination-hmac.pending");
    const creatorPause = deferred();
    const creatorResume = deferred();
    const contenderPause = deferred();
    const contenderResume = deferred();
    const readerPause = deferred();
    const readerResume = deferred();
    const readerSecondPass = deferred();
    const readerFirstPass = deferred<{
      finalNlink: number;
      pendingNlink: number;
      finalBytes: string;
      pendingBytes: string;
    }>();
    let readerPasses = 0;

    const creator = destinationKey(directory, {
      afterDestinationKeyPendingLinkBeforeTempUnlink: async () => {
        creatorPause.resolve();
        await creatorResume.promise;
      },
    });
    await creatorPause.promise;

    const contender = destinationKey(directory, {
      afterDestinationKeyPendingLink: async () => {
        contenderPause.resolve();
        await contenderResume.promise;
      },
    });
    await contenderPause.promise;

    const reader = destinationKey(directory, {
      afterDestinationKeyFinalSnapshot: async () => {
        readerPasses += 1;
        if (readerPasses === 1) {
          readerPause.resolve();
          const final = await lstat(finalPath);
          const pending = await lstat(pendingPath);
          const finalBytes = await readFile(finalPath, "utf8");
          const pendingBytes = await readFile(pendingPath, "utf8");
          readerFirstPass.resolve({
            finalNlink: final.nlink,
            pendingNlink: pending.nlink,
            finalBytes,
            pendingBytes,
          });
          await readerResume.promise;
        }
        if (readerPasses === 2) {
          readerSecondPass.resolve();
        }
      },
    });

    await readerPause.promise;
    const first = await readerFirstPass.promise;
    expect(first.finalNlink).toBe(3);
    expect(first.pendingNlink).toBe(3);
    expect(first.pendingBytes).toBe(first.finalBytes);
    readerResume.resolve();
    await readerSecondPass.promise;
    creatorResume.resolve();
    contenderResume.resolve();
    await creator;
    const [creatorValue, contenderValue, readerValue] = await Promise.all([creator, contender, reader]);
    expect(creatorValue.equals(contenderValue)).toBe(true);
    expect(readerValue.equals(contenderValue)).toBe(true);
    expect((await lstat(finalPath)).nlink).toBe(1);
    await expect(lstat(pendingPath)).rejects.toThrow();
    expect(readerPasses).toBeGreaterThanOrEqual(2);
  });
});
