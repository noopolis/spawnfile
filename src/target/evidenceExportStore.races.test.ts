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
  it("fails closed when late distinct pending is replaced by foreign valid data", async () => {
    const directory = await root(); const value = admission(); const destination = "/operator/private/foreign-late-loser.tar";
    const loserReady = deferred(); const continueLoser = deferred();
    const winnerFinal = path.join(directory, ".destination-hmac.key");
    const loserPending = path.join(directory, ".destination-hmac.pending");
    const loser = await initializeEvidenceExportAuthorityStore(directory, {
      beforeDestinationKeyLink: async () => {
        const foreign = `${"d".repeat(64)}`;
        await writeFile(winnerFinal, `${"c".repeat(64)}`, "utf8");
        await chmod(winnerFinal, 0o600);
        await unlink(loserPending);
        await writeFile(loserPending, foreign, "utf8");
        await chmod(loserPending, 0o600);
        loserReady.resolve();
        await continueLoser.promise;
      },
    });
    const loserWork = loser.bindDestination(value, destination);
    await loserReady.promise;
    const pendingValue = await readFile(path.join(directory, ".destination-hmac.pending"), "utf8");
    continueLoser.resolve();
    await expect(loserWork).rejects.toThrow("Evidence-volume export failed");
    expect(await readFile(path.join(directory, ".destination-hmac.pending"), "utf8")).toBe(pendingValue);
    expect((await stat(winnerFinal)).nlink).toBe(1);
  });

  it("handles repeated two-store races with concurrent loser convergence and stable one-winner selection", async () => {
    for (const shared of [true, false] as const) {
      for (let index = 0; index < 20; index += 1) {
        const directory = await root(); const value = admission();
        const destination = shared ? "/operator/private/shared.tar" : index % 2 === 0 ? "/operator/private/left.tar" : "/operator/private/right.tar";
        const otherDestination = shared ? "/operator/private/shared-other.tar" : destination === "/operator/private/left.tar" ? "/operator/private/right.tar" : "/operator/private/left.tar";
        const left = await initializeEvidenceExportAuthorityStore(directory); const right = await initializeEvidenceExportAuthorityStore(directory);
        await left.bindAdmission(value); await right.bindAdmission(value);
        const rightDestination = shared ? destination : otherDestination;
        const [leftResult, rightResult] = await Promise.allSettled([left.bindDestination(value, destination), right.bindDestination(value, rightDestination)]);
        if (shared) {
          if (leftResult.status === "rejected" || rightResult.status === "rejected") {
            if (leftResult.status === "rejected") throw leftResult.reason;
            if (rightResult.status === "rejected") throw rightResult.reason;
          }
          expect(leftResult.status).toBe("fulfilled");
          expect(rightResult.status).toBe("fulfilled");
          await left.requireDestination(value, destination);
          await right.requireDestination(value, destination);
        } else {
          expect(["fulfilled", "rejected"]).toContain(leftResult.status);
          expect(["fulfilled", "rejected"]).toContain(rightResult.status);
          expect([leftResult.status, rightResult.status].filter((status) => status === "fulfilled")).toHaveLength(1);
          expect([leftResult.status, rightResult.status].filter((status) => status === "rejected")).toHaveLength(1);
          const winnerStore = leftResult.status === "fulfilled" ? left : right;
          const loserStore = winnerStore === left ? right : left;
          const winnerDestination = winnerStore === left ? destination : rightDestination;
          const loserDestination = winnerStore === left ? rightDestination : destination;
          await winnerStore.requireDestination(value, winnerDestination);
          await expect(loserStore.requireDestination(value, loserDestination)).rejects.toThrow("Evidence-volume export failed");
        }
      }
    }
  }, 15_000);

  it("orchestrates K1/K2 loser races with a third reader observing convergence", async () => {
    const directory = await root(); const value = admission(); const destination = "/operator/private/k1-k2-third-reader.tar";
    const loserPausing = deferred(); const allowLoserContinue = deferred();
    const winner = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "1".repeat(64) });
    const loser = await initializeEvidenceExportAuthorityStore(directory, {
      createToken: () => "2".repeat(64),
      beforeDestinationKeyLink: async () => {
        loserPausing.resolve();
        await allowLoserContinue.promise;
      },
    });
    const reader = await initializeEvidenceExportAuthorityStore(directory);
    await winner.bindAdmission(value); await loser.bindAdmission(value); await reader.bindAdmission(value);

    const loserWork = loser.bindDestination(value, destination);
    await loserPausing.promise;
    const winnerWork = winner.bindDestination(value, destination);
    allowLoserContinue.resolve();
    await Promise.all([winnerWork, loserWork]);
    await winner.requireDestination(value, destination);
    await loser.requireDestination(value, destination);
    await reader.bindDestination(value, destination);
    await reader.requireDestination(value, destination);
  });

  it("rejects malformed then distinct valid pending when final key already converged", async () => {
    const directory = await root(); const value = admission(); const destination = "/operator/private/corrupt.tar";
    const file = path.join(directory, ".destination-hmac.key"); const pending = path.join(directory, ".destination-hmac.pending");
    const writer = await initializeEvidenceExportAuthorityStore(directory);
    await writer.bindAdmission(value);
    await writer.bindDestination(value, destination);
    const committed = await readFile(file, "utf8");
    expect(await stat(file)).toHaveProperty("nlink", 1);
    await expect(readFile(pending, "utf8")).rejects.toThrow();

    const second = await initializeEvidenceExportAuthorityStore(directory); await second.bindAdmission(value);
    await writeFile(pending, "not-a-valid-hash", "utf8"); await chmod(pending, 0o600);
    await expect(second.bindDestination(value, destination)).rejects.toThrow("Evidence-volume export failed");
    expect(await readFile(file, "utf8")).toBe(committed);

    const validPending = committed === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
    await writeFile(pending, validPending, "utf8"); await chmod(pending, 0o600);
    await expect(second.bindDestination(value, destination)).rejects.toThrow("Evidence-volume export failed");
    expect(await readFile(file, "utf8")).toBe(committed);
  });

  it("fails repeated final key publication when final has unrelated extra hard links and pending never exact-matches", async () => {
    const directory = await root(); const value = admission(); const destination = "/operator/private/unrelated-hardlink.tar";
    const file = path.join(directory, ".destination-hmac.key");
    const hardlink = path.join(directory, ".destination-hmac.hardlink");
    const winner = await initializeEvidenceExportAuthorityStore(directory);
    await winner.bindAdmission(value); await winner.bindDestination(value, destination);
    const committed = await readFile(file, "utf8");
    await link(file, hardlink);
    const loser = await initializeEvidenceExportAuthorityStore(directory);
    await loser.bindAdmission(value);
    await expect(loser.bindDestination(value, destination)).rejects.toThrow("Evidence-volume export failed");
    expect(await readFile(file, "utf8")).toBe(committed);
    await expect(stat(file)).resolves.toHaveProperty("nlink", 2);
    await unlink(hardlink);
  });

  it.each(["final", "pending"] as const)("pins and preserves a later live %s generation when a delayed recovery wakes", async (kind) => {
    const directory = await root(); const value = admission(); let alive = false;
    const firstSeen = deferred(); const allowFirst = deferred(); const livePublished = deferred(); const allowLive = deferred();
    const original = await initializeEvidenceExportAuthorityStore(directory, {
      createToken: () => "7".repeat(64), isProcessAlive: () => false,
      ...(kind === "pending" ? { afterClaimPendingCreated: async () => { firstSeen.resolve(); await allowFirst.promise; } } : {})
    });
    const originalClaim = original.claimExport(value);
    if (kind === "pending") await firstSeen.promise; else expect(await originalClaim).not.toBeNull();

    const delayed = await initializeEvidenceExportAuthorityStore(directory, { isProcessAlive: () => alive, afterStaleClaimObserved: async () => { firstSeen.resolve(); await allowFirst.promise; } });
    const delayedClear = delayed.clearStaleExportClaim(value); await firstSeen.promise;
    const secondRecovery = await initializeEvidenceExportAuthorityStore(directory, { isProcessAlive: () => false });
    expect(await secondRecovery.clearStaleExportClaim(value)).toBe(true);

    const live = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "8".repeat(64), isProcessAlive: () => true, ...(kind === "pending" ? { afterClaimPendingCreated: async () => { livePublished.resolve(); await allowLive.promise; } } : {}) });
    const liveCreating = live.claimExport(value); const liveClaim = kind === "pending" ? { token: "8".repeat(64) } : await liveCreating;
    if (kind === "pending") await livePublished.promise; else expect(liveClaim).toEqual({ token: "8".repeat(64) }); alive = true;
    allowFirst.resolve(); if (kind === "pending") await originalClaim;
    expect(await delayedClear).toBe(false); allowLive.resolve(); const completedLiveClaim = kind === "pending" ? await liveCreating : liveClaim;
    /* The delayed recovery may pin C briefly, but it recognizes the different
     * inode/token and can only remove that pin; C remains the sole owner. */
    const contender = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "9".repeat(64), isProcessAlive: () => true });
    expect(await contender.claimExport(value)).toBeNull();
    await live.releaseExport(value, completedLiveClaim!);
    const replacement = await contender.claimExport(value); expect(replacement).toEqual({ token: "9".repeat(64) }); await contender.releaseExport(value, replacement!);
  });

  it.each(["final", "pending"] as const)("allows exactly one clearer and exactly one later claimant for a dead %s generation", async (kind) => {
    const directory = await root(); const value = admission(); const staged = deferred(); const releaseStage = deferred();
    const dead = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "a".repeat(64), isProcessAlive: () => false, ...(kind === "pending" ? { afterClaimPendingCreated: async () => { staged.resolve(); await releaseStage.promise; } } : {}) });
    const creating = dead.claimExport(value); if (kind === "pending") await staged.promise; else expect(await creating).not.toBeNull();
    const one = await initializeEvidenceExportAuthorityStore(directory, { isProcessAlive: () => false }); const two = await initializeEvidenceExportAuthorityStore(directory, { isProcessAlive: () => false });
    const cleared = await Promise.all([one.clearStaleExportClaim(value), two.clearStaleExportClaim(value)]); expect(cleared.filter(Boolean)).toHaveLength(1);
    releaseStage.resolve(); if (kind === "pending") await creating;
    const left = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "b".repeat(64), isProcessAlive: () => true }); const right = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "c".repeat(64), isProcessAlive: () => true });
    const claims = await Promise.all([left.claimExport(value), right.claimExport(value)]); expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    const winner = claims[0] ? left : right; await winner.releaseExport(value, claims[0] ?? claims[1]!);
  });

  it.each(["final", "pending"] as const)("treats an exact recovery tombstone as incomplete and lets a live %s owner release safely", async (kind) => {
    const directory = await root(); const value = admission(); let alive = false;
    const pendingPublished = deferred(); const allowPublish = deferred(); const recoveryPinned = deferred(); const allowRecovery = deferred(); const releaseSawPin = deferred(); const allowRelease = deferred();
    const owner = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "d".repeat(64), onReleaseRecoveryTombstone: async () => { releaseSawPin.resolve(); await allowRelease.promise; }, ...(kind === "pending" ? { afterClaimPendingCreated: async () => { pendingPublished.resolve(); await allowPublish.promise; } } : {}) });
    const creating = owner.claimExport(value); const ownerClaim = kind === "pending" ? { token: "d".repeat(64) } : await creating;
    if (kind === "pending") await pendingPublished.promise;
    const recovery = await initializeEvidenceExportAuthorityStore(directory, { isProcessAlive: () => alive, afterRecoveryTombstoneLinked: async () => { recoveryPinned.resolve(); await allowRecovery.promise; } });
    const clearing = recovery.clearStaleExportClaim(value); await recoveryPinned.promise;
    const blocked = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "e".repeat(64) }); expect(await blocked.claimExport(value)).toBeNull();
    const releasing = owner.releaseExport(value, ownerClaim!); await releaseSawPin.promise;
    alive = true; allowRecovery.resolve(); expect(await clearing).toBe(false);
    allowRelease.resolve(); await releasing; allowPublish.resolve(); if (kind === "pending") await creating;
    const replacement = await blocked.claimExport(value); expect(replacement).toEqual({ token: "e".repeat(64) }); await blocked.releaseExport(value, replacement!);
  });

  it("does not let a delayed release delete a later same-token generation", async () => {
    const directory = await root(); const value = admission(); const token = "f".repeat(64); const observed = deferred(); const allowDelayed = deferred();
    const first = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => token }); const firstClaim = await first.claimExport(value); expect(firstClaim).toEqual({ token });
    const delayed = await initializeEvidenceExportAuthorityStore(directory, { afterReleaseClaimObserved: async () => { observed.resolve(); await allowDelayed.promise; } });
    const delayedRelease = delayed.releaseExport(value, firstClaim!); await observed.promise;
    await first.releaseExport(value, firstClaim!);
    const later = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => token }); const laterClaim = await later.claimExport(value); expect(laterClaim).toEqual({ token });
    allowDelayed.resolve(); await delayedRelease;
    const blocked = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "1".repeat(64) }); expect(await blocked.claimExport(value)).toBeNull();
    await later.releaseExport(value, laterClaim!); const replacement = await blocked.claimExport(value); expect(replacement).toEqual({ token: "1".repeat(64) }); await blocked.releaseExport(value, replacement!);
  });
});
