import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireReleaseLock,
  appendReleaseLog,
  ensureReleaseDirectory,
  readReleaseLedger,
  resolveReleasePaths,
  writeReleaseLedger,
  type ReleaseLedger
} from "./ledger.js";
import { clearDeferral, markDeferralNotified, recordDeferral } from "./pending.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-release-ledger-")); });
afterEach(async () => { await rm(root, { force: true, recursive: true }); });

const ledger: ReleaseLedger = {
  compile_fingerprint: "sf1:x",
  deployment: "org",
  identity: `sha256:${"a".repeat(64)}`,
  image_id: "sha256:1",
  image_tag: "spawnfile-org:r-aaaaaaaaaaaa",
  previous_image_tag: null,
  released_at: "2026-10-08T00:00:00.000Z",
  timings: { build_ms: null, compile_ms: 1, deploy_ms: 2, drain_ms: 0, total_ms: 3 },
  version: "spawnfile.release-ledger.v1"
};

describe("release ledger", () => {
  it("lives in a private per-deployment directory and rejects a non-kebab deployment", async () => {
    const paths = resolveReleasePaths("org", root);
    await ensureReleaseDirectory(paths);
    expect((await stat(paths.directory)).mode & 0o777).toBe(0o700);
    expect(() => resolveReleasePaths("../escape", root)).toThrow();
  });

  it("reads missing as null, round-trips a record, and writes it 0600", async () => {
    const paths = resolveReleasePaths("org", root);
    await ensureReleaseDirectory(paths);
    expect(await readReleaseLedger(paths.ledger)).toBeNull();
    await writeReleaseLedger(paths.ledger, ledger);
    expect(await readReleaseLedger(paths.ledger)).toEqual(ledger);
    expect((await stat(paths.ledger)).mode & 0o777).toBe(0o600);
  });

  it("refuses a ledger it cannot read rather than assuming it is stale", async () => {
    const paths = resolveReleasePaths("org", root);
    await ensureReleaseDirectory(paths);
    await writeFile(paths.ledger, JSON.stringify({ ...ledger, version: "other" }));
    await expect(readReleaseLedger(paths.ledger)).rejects.toMatchObject({ reason: "blocked" });
    await expect(readReleaseLedger(root)).rejects.toMatchObject({ reason: "blocked" });
  });

  it("appends versioned log lines", async () => {
    const paths = resolveReleasePaths("org", root);
    await ensureReleaseDirectory(paths);
    await appendReleaseLog(paths.log, { at: "t", deployment: "org", identity: null, outcome: "failed", reason: "blocked" });
    expect(JSON.parse(await readFile(paths.log, "utf8"))).toMatchObject({ outcome: "failed", version: "spawnfile.release-log.v1" });
  });

  it("puts back a live lock another process took over between reading the stale one and reclaiming it", async () => {
    const paths = resolveReleasePaths("org", root);
    await ensureReleaseDirectory(paths);
    await writeFile(paths.lock, JSON.stringify({ pid: 2 ** 22 + 7 }));
    const fresh = JSON.stringify({ pid: process.pid, token: "other" });
    await expect(acquireReleaseLock(paths, { afterStaleRead: async () => { await rm(paths.lock); await writeFile(paths.lock, fresh); } }))
      .rejects.toMatchObject({ reason: "blocked" });
    expect(await readFile(paths.lock, "utf8")).toBe(fresh);
  });

  it("never lets concurrent acquisitions both win", async () => {
    const paths = resolveReleasePaths("org", root);
    await ensureReleaseDirectory(paths);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireReleaseLock(paths)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("holds one release per deployment and reclaims a lock whose owner is gone", async () => {
    const paths = resolveReleasePaths("org", root);
    await ensureReleaseDirectory(paths);
    const unlock = await acquireReleaseLock(paths);
    await expect(acquireReleaseLock(paths)).rejects.toMatchObject({ reason: "blocked" });
    await unlock();
    await writeFile(paths.lock, JSON.stringify({ pid: 2 ** 22 + 7 }));
    const again = await acquireReleaseLock(paths);
    await again();
  });
});

describe("deferral tracking", () => {
  it("notifies once per pending identity after the threshold and restarts for a new identity", async () => {
    const file = path.join(root, "pending.json");
    const at = (iso: string) => ({ notifyAfterMs: 3_600_000, now: new Date(iso) });
    expect((await recordDeferral(file, "id-1", at("2026-10-08T00:00:00.000Z"))).notify).toBe(false);
    const due = await recordDeferral(file, "id-1", at("2026-10-08T01:00:00.000Z"));
    expect(due.notify).toBe(true);
    // Not delivered yet: still due.
    expect((await recordDeferral(file, "id-1", at("2026-10-08T01:30:00.000Z"))).notify).toBe(true);
    await markDeferralNotified(file, due.pending);
    expect((await recordDeferral(file, "id-1", at("2026-10-08T02:00:00.000Z"))).notify).toBe(false);
    const fresh = await recordDeferral(file, "id-2", at("2026-10-08T03:00:00.000Z"));
    expect(fresh).toMatchObject({ ageMs: 0, notify: false });
    await clearDeferral(file);
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });

  it("notifies immediately when the record holding 'waiting since' is broken", async () => {
    const file = path.join(root, "pending.json");
    await writeFile(file, "{broken");
    expect(await recordDeferral(file, "id-1", { notifyAfterMs: 3_600_000 })).toMatchObject({ notify: true, trackingBroken: expect.stringContaining("cannot be read") });
    const unwritable = path.join(root, "missing-dir", "pending.json");
    expect(await recordDeferral(unwritable, "id-1", { notifyAfterMs: 3_600_000 })).toMatchObject({ notify: true, trackingBroken: expect.stringContaining("could not be written") });
  });
});
