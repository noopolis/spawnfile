import { chmod, link, mkdtemp, readdir, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseOpaqueTargetHandle } from "./contracts.js";
import { createDockerResourceSpec } from "./dockerResourcesProvider.js";
import { EVIDENCE_EXPORT_HELPER_CONTRACT, createEvidenceExportHelper, parseEvidenceVolumeAuthority } from "./evidenceExportProvider.js";
import { initializeEvidenceExportAuthorityStore, type EvidenceExportAdmission } from "./evidenceExportStore.js";

const roots: string[] = [];
const root = async (): Promise<string> => { const value = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-export-store-"))); roots.push(value); return value; };
afterEach(async () => Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true }))));

const admission = (): EvidenceExportAdmission => {
  const selected = parseOpaqueTargetHandle("opaque_dddddddddddddddd");
  const volume = createDockerResourceSpec({ kind: "evidence_volume", operationHandle: parseOpaqueTargetHandle("opaque_eeeeeeeeeeeeeeee"), requestDigest: `sha256:${"f".repeat(64)}`, runId: "run-one", selectedTargetHandle: selected });
  return { descriptor_digest: `sha256:${"a".repeat(64)}`, evidence_volume: parseEvidenceVolumeAuthority({ labels: volume.labels, name: volume.name, resultHandle: volume.resultHandle }), helper: createEvidenceExportHelper({ artifactManifestDigest: `sha256:${"b".repeat(64)}`, imageDigest: `sha256:${"c".repeat(64)}`, imageReference: `registry.example/export@sha256:${"c".repeat(64)}`, resultHandle: parseOpaqueTargetHandle("opaque_bbbbbbbbbbbbbbbb") }), helper_contract: EVIDENCE_EXPORT_HELPER_CONTRACT, operation_handle: parseOpaqueTargetHandle("opaque_cccccccccccccccc"), request_digest: `sha256:${"d".repeat(64)}`, run_id: "run-one", selected_target: { fingerprint: `sha256:${"e".repeat(32)}`, handle: selected }, version: "spawnfile.target-evidence-export.private.v1" };
};
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
};

describe("evidence export private operation claim", () => {
  it("excludes separate stores, rejects authority drift, and releases an owner failure for retry", async () => {
    const directory = await root(); const value = admission();
    const first = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "1".repeat(64) });
    const second = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "2".repeat(64) });
    const owned = await first.claimExport(value); expect(owned).not.toBeNull();
    await expect(second.claimExport(value)).resolves.toBeNull();
    await expect(second.claimExport({ ...value, descriptor_digest: `sha256:${"f".repeat(64)}` })).rejects.toThrow("Evidence-volume export failed");
    await first.releaseExport(value, owned!);
    const retried = await second.claimExport(value); expect(retried).toEqual({ token: "2".repeat(64) });
    await second.releaseExport(value, retried!);
  });

  it("never steals a live claim; recovery clears a dead exact generation and a later O_EXCL elects one owner", async () => {
    const directory = await root(); const value = admission();
    const live = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "3".repeat(64), isProcessAlive: () => true });
    const owned = await live.claimExport(value); expect(owned).not.toBeNull();
    expect(await live.clearStaleExportClaim(value)).toBe(false);
    await live.releaseExport(value, owned!);

    const dead = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "4".repeat(64), isProcessAlive: () => false });
    expect(await dead.claimExport(value)).not.toBeNull();
    /* Normal callers report incomplete even for dead records; only recovery may
     * clear, and it cannot claim in the same operation. */
    expect(await dead.claimExport(value)).toBeNull();
    expect(await dead.clearStaleExportClaim(value)).toBe(true);
    const left = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "5".repeat(64), isProcessAlive: () => true });
    const right = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "6".repeat(64), isProcessAlive: () => true });
    const contenders = await Promise.all([left.claimExport(value), right.claimExport(value)]);
    expect(contenders.filter((claim) => claim !== null)).toHaveLength(1);
    const winner = contenders[0] ? left : right; const claim = contenders[0] ?? contenders[1];
    await winner.releaseExport(value, claim!);
  });

  it("recovers the one shared HMAC key before and after publication, with no path persisted", async () => {
    const value = admission(); const destination = "/operator/very-private/final.tar";
    for (const phase of ["before", "after"] as const) {
      const directory = await root();
      const first = await initializeEvidenceExportAuthorityStore(directory, phase === "before" ? { beforeDestinationKeyLink: async () => { throw new Error("simulated crash"); } } : { afterDestinationKeyLinkBeforePendingUnlink: async () => { throw new Error("simulated crash"); } });
      await first.bindAdmission(value);
      await expect(first.bindDestination(value, destination)).rejects.toThrow("Evidence-volume export failed");
      const second = await initializeEvidenceExportAuthorityStore(directory); await second.bindAdmission(value); await second.bindDestination(value, destination); await second.requireDestination(value, destination);
      const files = await readdir(directory); const key = path.join(directory, ".destination-hmac.key"); expect((await stat(key)).mode & 0o777).toBe(0o600); expect((await stat(key)).nlink).toBe(1);
      const contents = await Promise.all(files.map((file) => readFile(path.join(directory, file), "utf8"))); expect(contents.join("\n")).not.toContain(destination); expect(contents.join("\n")).not.toContain("final.tar");
    }
  });

  it("has one HMAC-key winner under concurrent fresh stores and rejects mode corruption", async () => {
    const directory = await root(); const value = admission(); const destination = "/operator/private/match.tar";
    const [left, right] = await Promise.all([initializeEvidenceExportAuthorityStore(directory), initializeEvidenceExportAuthorityStore(directory)]);
    await left.bindAdmission(value); await right.bindAdmission(value);
    await Promise.all([left.bindDestination(value, destination), right.bindDestination(value, destination)]);
    await left.requireDestination(value, destination); await right.requireDestination(value, destination);
    await chmod(path.join(directory, ".destination-hmac.key"), 0o640);
    await expect(left.requireDestination(value, destination)).rejects.toThrow("Evidence-volume export failed");
  });

  it("rejoins an existing destination key when a loser resumes after winner cleanup", async () => {
    const directory = await root(); const value = admission(); const destination = "/operator/private/clean-rejoin.tar";
    const winnerRecovered = deferred(); const beforeWinner = deferred();
    const pending = path.join(directory, ".destination-hmac.pending");
    const final = path.join(directory, ".destination-hmac.key");
    const winner = await initializeEvidenceExportAuthorityStore(directory, { afterDestinationKeyRecovered: async () => { winnerRecovered.resolve(); } });
    const loser = await initializeEvidenceExportAuthorityStore(directory, { beforeDestinationKeyLink: async () => { beforeWinner.resolve(); await winnerRecovered.promise; } });
    await winner.bindAdmission(value); await loser.bindAdmission(value);

    const loserWork = loser.bindDestination(value, destination);
    await beforeWinner.promise;
    const winnerWork = winner.bindDestination(value, destination);
    await winnerWork; await loserWork;
    await winner.requireDestination(value, destination); await loser.requireDestination(value, destination);
    const winnerKey = await readFile(final, "utf8");
    expect(winnerKey).toHaveLength(64);
    expect(winnerKey).toMatch(/^[0-9a-f]{64}$/u);
    expect((await stat(final)).nlink).toBe(1);
    await expect(stat(pending)).rejects.toThrow();
  });

  it("retries when pending disappears between lstat and open and reconverges on final", async () => {
    const directory = await root(); const value = admission(); const destination = "/operator/private/rejoin-enored-late-open.tar";
    let lstatOpenCount = 0;
    const winner = await initializeEvidenceExportAuthorityStore(directory, { afterDestinationKeyLinkBeforePendingUnlink: async () => { throw new Error("simulated crash"); } });
    const pending = path.join(directory, ".destination-hmac.pending");
    await winner.bindAdmission(value);
    await expect(winner.bindDestination(value, destination)).rejects.toThrow("Evidence-volume export failed");
    const loser = await initializeEvidenceExportAuthorityStore(directory, {
      afterDestinationKeyPendingLstatBeforeOpen: async () => {
        lstatOpenCount += 1;
        await unlink(pending);
      },
    });
    await loser.bindAdmission(value);
    await loser.bindDestination(value, destination);
    expect(lstatOpenCount).toBe(1);
    await loser.requireDestination(value, destination);
    await winner.requireDestination(value, destination);
  });

  it("runs the initial-final-absent hook before pending writes", async () => {
    const directory = await root(); const value = admission(); const destination = "/operator/private/initial-final-hook.tar";
    const pending = path.join(directory, ".destination-hmac.pending");
    const hookReached = deferred<void>();
    const continueRun = deferred<void>();
    const store = await initializeEvidenceExportAuthorityStore(directory, {
      afterDestinationKeyInitialFinalAbsent: async () => {
        hookReached.resolve();
        await continueRun.promise;
      },
    });

    await store.bindAdmission(value);
    const outcome = store.bindDestination(value, destination);
    await hookReached.promise;
    await expect(readFile(pending, "utf8")).rejects.toThrow();
    continueRun.resolve();
    await expect(outcome).resolves.toBeUndefined();
    await store.requireDestination(value, destination);
  });

  it("rejects a hostile pending-only inode at nlink3 before final key creation and does not mutate hostile links", async () => {
    const directory = await root(); const value = admission(); const destination = "/operator/private/hostile-nlink3-pending.tar";
    const store = await initializeEvidenceExportAuthorityStore(directory);
    await store.bindAdmission(value);
    const pending = path.join(directory, ".destination-hmac.pending");
    const temporary = path.join(directory, ".destination-hmac.pending.base");
    const hostileA = path.join(directory, ".destination-hmac.pending.hostile-a");
    const hostileB = path.join(directory, ".destination-hmac.pending.hostile-b");
    await writeFile(temporary, `${"0".repeat(63)}1`, "utf8");
    await chmod(temporary, 0o600);
    await link(temporary, pending);
    await link(pending, hostileA);
    await link(pending, hostileB);
    await unlink(temporary);
    const before = await Promise.all([stat(pending), stat(hostileA), stat(hostileB)]);
    before.forEach((snapshot) => expect(snapshot.nlink).toBe(3));
    const beforeBytes = await readFile(pending, "utf8");
    await expect(store.bindDestination(value, destination)).rejects.toThrow("Evidence-volume export failed");
    const key = path.join(directory, ".destination-hmac.key");
    await expect(stat(key)).rejects.toThrow();
    const after = await Promise.all([stat(pending), stat(hostileA), stat(hostileB)]);
    const afterBytes = await readFile(pending, "utf8");
    before.forEach((snapshot, index) => {
      expect(after[index].ino).toBe(snapshot.ino);
      expect(after[index].dev).toBe(snapshot.dev);
      expect(after[index].nlink).toBe(3);
    });
    expect(afterBytes).toBe(beforeBytes);
  });

  it("reconverges nlink3 when pending is linked to final before temp cleanup", async () => {
    const directory = await root(); const value = admission(); const destination = "/operator/private/nlink3.tar";
    const creatorPaused = deferred(); const contenderPaused = deferred(); const allowCreatorContinue = deferred();
    const creator = await initializeEvidenceExportAuthorityStore(directory, {
      afterDestinationKeyPendingLinkBeforeTempUnlink: async () => { creatorPaused.resolve(); await allowCreatorContinue.promise; },
    });
    const contender = await initializeEvidenceExportAuthorityStore(directory, {
      afterDestinationKeyPendingLink: async () => { contenderPaused.resolve(); },
    });
    await creator.bindAdmission(value); await contender.bindAdmission(value);
    const creatorOutcome = creator.bindDestination(value, destination);
    await creatorPaused.promise;
    const contenderOutcome = contender.bindDestination(value, destination);
    await contenderPaused.promise;
    const key = path.join(directory, ".destination-hmac.key");
    expect((await stat(key)).nlink).toBe(3);
    allowCreatorContinue.resolve();
    await expect(creatorOutcome).resolves.toBeUndefined(); await expect(contenderOutcome).resolves.toBeUndefined();
    await creator.requireDestination(value, destination); await contender.requireDestination(value, destination);
    const pending = path.join(directory, ".destination-hmac.pending");
    expect((await stat(key)).nlink).toBe(1);
    await expect(stat(pending)).rejects.toThrow();
    const entries = await readdir(directory);
    const tempFiles = entries.filter((file) => file.includes(".destination-hmac.") && file.endsWith(".tmp"));
    expect(tempFiles).toEqual([]);
  });

  it("retries immutable admission publication on transient nlink2 and rejects persistent unrelated hardlinks", async () => {
    const directory = await root(); const value = admission();
    const paused = deferred(); const continuePublish = deferred();
    const publisher = await initializeEvidenceExportAuthorityStore(directory, {
      afterImmutableFinalLinkBeforeTempUnlink: async () => {
        paused.resolve();
        await continuePublish.promise;
      },
    });
    const reader = await initializeEvidenceExportAuthorityStore(directory);
    const first = publisher.bindAdmission(value);
    await paused.promise;
    const second = reader.bindAdmission(value);
    continuePublish.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    const entries = await readdir(directory);
    const admissionFile = entries.find((file) => file.endsWith(".admission.json"));
    expect(admissionFile).toBeDefined();
    const hardlink = path.join(directory, ".admission.hardlink");
    const final = path.join(directory, admissionFile!);
    expect((await stat(final)).nlink).toBe(1);
    await link(final, hardlink);
    await expect(reader.bindAdmission(value)).rejects.toThrow("Evidence-volume export failed");
    expect((await stat(final)).nlink).toBe(2);
    await unlink(hardlink);
    const tempFiles = await readdir(directory);
    expect(tempFiles.filter((file) => file.includes(".destination-hmac.") && file.endsWith(".tmp"))).toEqual([]);
  });

  it("retries stale destination-key final snapshots on transient nlink3 and converges after cleanup", async () => {
    const directory = await root(); const value = admission(); const destination = "/operator/private/stale-final-nlink2.tar";
    const winner = await initializeEvidenceExportAuthorityStore(directory);
    await winner.bindAdmission(value);
    await winner.bindDestination(value, destination);
    const key = path.join(directory, ".destination-hmac.key");
    const hardlink = path.join(directory, ".destination-hmac.final-hardlink");
    const hardlink2 = path.join(directory, ".destination-hmac.final-hardlink-2");
    const seen = deferred(); const continueRead = deferred();
    let armed = false;
    const stale = await initializeEvidenceExportAuthorityStore(directory, {
      afterDestinationKeyFinalSnapshot: async () => {
        if (armed) return;
        armed = true;
        await link(key, hardlink);
        await link(key, hardlink2);
        seen.resolve();
        await continueRead.promise;
        await unlink(hardlink);
        await unlink(hardlink2);
      },
    });
    const outcome = stale.bindDestination(value, destination);
    await seen.promise;
    continueRead.resolve();
    await expect(outcome).resolves.toBeUndefined();
    expect((await stat(key)).nlink).toBe(1);
    await expect(stat(hardlink)).rejects.toThrow();
    await expect(stat(hardlink2)).rejects.toThrow();
  });

  it("keeps a live distinct foreign final pending during bounded mismatch retries", async () => {
    const directory = await root(); const value = admission(); const destination = "/operator/private/distinct-final-live-pending.tar";
    const winner = await initializeEvidenceExportAuthorityStore(directory);
    await winner.bindAdmission(value);
    await winner.bindDestination(value, destination);

    const key = path.join(directory, ".destination-hmac.key");
    const keyHardlink = path.join(directory, ".destination-hmac.key-distinct-peer");
    const temporary = path.join(directory, ".destination-hmac.distinct.final.tmp");
    const pending = path.join(directory, ".destination-hmac.pending");
    const peerA = path.join(directory, ".destination-hmac.distinct-hostile-a");
    const peerB = path.join(directory, ".destination-hmac.distinct-hostile-b");
    const finalRead = deferred(); const finalContinue = deferred();
    const foreign = `${"f".repeat(64)}`;
    let armed = false;

    await link(key, keyHardlink);
    await writeFile(temporary, foreign, "utf8");
    await chmod(temporary, 0o600);
    await link(temporary, pending);
    await link(pending, peerA);
    await link(pending, peerB);
    await unlink(temporary);

    const before = await Promise.all([stat(pending), stat(peerA), stat(peerB), stat(key)]);
    expect(before[0].nlink).toBe(3);
    expect(before[1].nlink).toBe(3);
    expect(before[2].nlink).toBe(3);
    expect(before[3].nlink).toBe(2);

    const stale = await initializeEvidenceExportAuthorityStore(directory, {
      afterDestinationKeyFinalSnapshot: async () => {
        if (armed) return;
        armed = true;
        finalRead.resolve();
        await finalContinue.promise;
        await unlink(keyHardlink);
      },
    });
    await stale.bindAdmission(value);

    const outcome = stale.bindDestination(value, destination);
    await finalRead.promise;
    finalContinue.resolve();
    await expect(outcome).rejects.toThrow("Evidence-volume export failed");

    const after = await Promise.all([stat(pending), stat(peerA), stat(peerB), stat(key)]);
    expect(after[0].ino).toBe(before[0].ino);
    expect(after[0].nlink).toBe(3);
    expect(after[1].ino).toBe(before[1].ino);
    expect(after[1].nlink).toBe(3);
    expect(after[2].ino).toBe(before[2].ino);
    expect(after[2].nlink).toBe(3);
    expect(after[3].ino).toBe(before[3].ino);
    expect(await readFile(pending, "utf8")).toBe(foreign);
    expect((await stat(key)).nlink).toBe(1);
  });

  it("retries destination-key when an initial final-null stale reader sees peer nlink3 and converges after cleanup", async () => {
    const directory = await root(); const value = admission(); const destination = "/operator/private/stale-nlink3.tar";
    const writer = await initializeEvidenceExportAuthorityStore(directory);
    await writer.bindAdmission(value);
    const valuePath = path.join(directory, ".destination-hmac.key");
    const temporary = path.join(directory, ".destination-hmac.nlink3.tmp");
    const pending = path.join(directory, ".destination-hmac.pending");
    const peerExtra = path.join(directory, ".destination-hmac.peer-extra");
    const peerExtra2 = path.join(directory, ".destination-hmac.peer-extra-2");
    const firstSeen = deferred(); const allowContinue = deferred();
    const valueBytes = `${"e".repeat(64)}`;
    let armed = false;
    await writeFile(temporary, valueBytes, "utf8"); await chmod(temporary, 0o600);
    await link(temporary, pending);
    await link(pending, peerExtra);
    await link(pending, peerExtra2);
    await unlink(temporary);
    const stale = await initializeEvidenceExportAuthorityStore(directory, {
      afterDestinationKeyPendingLstatBeforeOpen: async () => {
        if (armed) return;
        armed = true;
        await unlink(peerExtra2);
        firstSeen.resolve();
        await link(pending, valuePath);
        await allowContinue.promise;
      },
    });
    const staleOutcome = stale.bindDestination(value, destination);
    await firstSeen.promise;
    await unlink(peerExtra);
    await unlink(pending);
    allowContinue.resolve();
    await expect(staleOutcome).resolves.toBeUndefined();
    expect((await stat(valuePath)).nlink).toBe(1);
    await expect(stat(pending)).rejects.toThrow();
  });

  it("cleans its exact distinct late pending when a winner final appears and converges", async () => {
    const directory = await root(); const value = admission(); const destination = "/operator/private/late-loser.tar";
    const loserReady = deferred(); const continueLoser = deferred();
    const winnerFinal = path.join(directory, ".destination-hmac.key");
    let loserPending = "";
    const loser = await initializeEvidenceExportAuthorityStore(directory, {
      beforeDestinationKeyLink: async () => {
        loserPending = await readFile(path.join(directory, ".destination-hmac.pending"), "utf8");
        await writeFile(winnerFinal, "b".repeat(64), "utf8");
        await chmod(winnerFinal, 0o600);
        loserReady.resolve();
        await continueLoser.promise;
      },
    });
    const loserWork = loser.bindDestination(value, destination);
    await loserReady.promise;
    const winnerBytes = await readFile(winnerFinal, "utf8");
    expect(loserPending).not.toBe(winnerBytes);
    continueLoser.resolve();
    await expect(loserWork).resolves.toBeUndefined();
    expect((await stat(winnerFinal)).nlink).toBe(1);
    await expect(stat(path.join(directory, ".destination-hmac.pending"))).rejects.toThrow();
    await loser.requireDestination(value, destination);
  });


});
