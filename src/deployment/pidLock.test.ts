import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquirePidLock, PidLockBusyError } from "./pidLock.js";

let root: string;
let lock: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-pid-lock-")); lock = path.join(root, ".lock"); });
afterEach(async () => { await rm(root, { force: true, recursive: true }); });

const DEAD_PID = 2 ** 22 + 7;

describe("acquirePidLock", () => {
  it("publishes the lock with its owner already inside and leaves no staging files", async () => {
    const release = await acquirePidLock(lock);
    expect(JSON.parse(await readFile(lock, "utf8"))).toMatchObject({ pid: process.pid });
    expect((await readdir(root)).sort()).toEqual([".lock"]);
    await release();
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses while a live owner holds it", async () => {
    const release = await acquirePidLock(lock);
    await expect(acquirePidLock(lock)).rejects.toBeInstanceOf(PidLockBusyError);
    await release();
  });

  it("reclaims a lock whose owner is gone, including an empty one", async () => {
    await writeFile(lock, JSON.stringify({ pid: DEAD_PID }));
    await (await acquirePidLock(lock))();
    await writeFile(lock, "");
    await (await acquirePidLock(lock))();
  });

  it("puts back a live lock that replaced the stale one between the read and the move", async () => {
    await writeFile(lock, JSON.stringify({ pid: DEAD_PID }));
    const fresh = JSON.stringify({ pid: process.pid, token: "other" });
    await expect(acquirePidLock(lock, { afterStaleRead: async () => { await rm(lock); await writeFile(lock, fresh); } }))
      .rejects.toBeInstanceOf(PidLockBusyError);
    expect(await readFile(lock, "utf8")).toBe(fresh);
  });

  it("never removes a lock it no longer owns on release", async () => {
    const release = await acquirePidLock(lock);
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: "someone-else" }));
    await release();
    expect(JSON.parse(await readFile(lock, "utf8"))).toMatchObject({ token: "someone-else" });
  });

  it("lets exactly one of many concurrent contenders win", async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquirePidLock(lock)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });
});
