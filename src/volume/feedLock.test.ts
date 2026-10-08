import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireFeedLock, FEED_LOCK_FILE } from "./feedLock.js";

let dir: string;
afterEach(() => rmSync(dir, { force: true, recursive: true }));
const fresh = (): string => (dir = mkdtempSync(path.join(tmpdir(), "spawnfile-feed-lock-")));
const ownerText = (pid: number, host = hostname()): string => `${JSON.stringify({ at: "2026-01-01T00:00:00.000Z", host, pid, token: "t" })}\n`;
const deadPid = (): number => {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
};

describe("acquireFeedLock", () => {
  it("admits exactly one holder until it releases", () => {
    const state = fresh();
    const first = acquireFeedLock(state);
    expect(first).not.toBeNull();
    expect(acquireFeedLock(state)).toBeNull();
    first?.release();
    expect(existsSync(path.join(state, FEED_LOCK_FILE))).toBe(false);
    const second = acquireFeedLock(state);
    expect(second).not.toBeNull();
    // A stale release from the first holder must not free the second holder's lock.
    first?.release();
    expect(acquireFeedLock(state)).toBeNull();
    second?.release();
  });

  it("holds against a live holder in another process and reclaims a dead holder's lock", async () => {
    const state = fresh();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      writeFileSync(path.join(state, FEED_LOCK_FILE), ownerText(child.pid as number));
      expect(acquireFeedLock(state)).toBeNull();
    } finally { child.kill("SIGKILL"); }
    await new Promise((resolve) => child.on("close", resolve));
    const lock = acquireFeedLock(state);
    expect(lock).not.toBeNull();
    expect(JSON.parse(readFileSync(path.join(state, FEED_LOCK_FILE), "utf8")).pid).toBe(process.pid);
    lock?.release();
  });

  it("never reclaims a lock it cannot prove dead, and reports a lock with no holder", () => {
    const state = fresh();
    writeFileSync(path.join(state, FEED_LOCK_FILE), ownerText(deadPid(), "another-host"));
    expect(acquireFeedLock(state)).toBeNull();
    writeFileSync(path.join(state, FEED_LOCK_FILE), "");
    expect(() => acquireFeedLock(state)).toThrow(/does not name a holder[\s\S]*rm -- /u);
  });

  it("never clears a live reclaimer's guard, however old, and clears a dead one", async () => {
    const state = fresh();
    const lockFile = path.join(state, FEED_LOCK_FILE), guard = `${lockFile}.reclaim`;
    writeFileSync(lockFile, ownerText(deadPid()));
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      writeFileSync(guard, ownerText(child.pid as number));
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(guard, old, old);
      expect(acquireFeedLock(state)).toBeNull();
      expect(readFileSync(guard, "utf8")).toBe(ownerText(child.pid as number));
    } finally { child.kill("SIGKILL"); }
    await new Promise((resolve) => child.on("close", resolve));
    const lock = acquireFeedLock(state);
    expect(lock).not.toBeNull();
    expect(existsSync(guard)).toBe(false);
    lock?.release();
  });
});
