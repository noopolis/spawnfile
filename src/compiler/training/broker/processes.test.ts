import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, rm, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { GROK_SOCKET_PLACEHOLDER_PROGRAM } from "../../containerDaimonGrokTaskClock.js";
import { isStartedBrokerSocket } from "./processes.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("broker startup with clocked socket deny targets", () => {
  it.skipIf(process.platform !== "linux")("leaves a real, owned socket inode that a listener can replace after startup attestation (Linux)", async () => {
    // Short paths: Unix sockets have a small platform-specific address bound.
    const root = await mkdtemp("/tmp/spawnfile-socket-"); roots.push(root);
    const file = `${root}/backend.sock`, uid = process.getuid!(), gid = process.getgid!();
    execFileSync(process.execPath, ["-e", GROK_SOCKET_PLACEHOLDER_PROGRAM, file, String(uid), String(gid)], { timeout: 5000 });
    const placeholder = await lstat(file);
    expect(placeholder.isSocket()).toBe(true);
    expect([placeholder.uid, placeholder.gid, placeholder.mode & 0o7777]).toEqual([uid, gid, 0o600]);
    expect(isStartedBrokerSocket(placeholder, placeholder)).toBe(false);
    // Daimon's backend refuses a regular file, accepts an owned socket, then unlinks and listens.
    await unlink(file);
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(file, resolve); });
    try { expect(isStartedBrokerSocket(await lstat(file), placeholder)).toBe(true); }
    finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("creates socket placeholders with the backend's uid and modes before the child exits", () => {
    const steps: string[] = [];
    const socket = "/run/daimon-engine-broker/backend.sock";
    const fs = { chmodSync: (file: string, mode: number) => { expect(file).toBe(socket); steps.push(`mode ${mode.toString(8)}`); },
      chownSync: (file: string, uid: number, gid: number) => { expect(file).toBe(socket); steps.push(`owner ${uid}:${gid}`); } };
    const server = { on: () => undefined, listen: (file: string, ready: () => void) => {
      expect(file).toBe(socket); steps.push("socket"); ready();
    } };
    new Function("require", "process", GROK_SOCKET_PLACEHOLDER_PROGRAM)(
      (name: string) => name === "node:fs" ? fs : { createServer: () => server },
      { argv: ["node", socket, "2100", "2100"], exit: (status: number) => steps.push(`exit ${status}`) }
    );
    expect(steps).toEqual(["socket", "mode 600", "owner 2100:2100", "exit 0"]);
  });

  it("never treats a missing socket, a file, or the unchanged placeholder as readiness", () => {
    const previous = { dev: 1, ino: 2, ctimeMs: 3, isSocket: () => true };
    expect(isStartedBrokerSocket(undefined, previous)).toBe(false);
    expect(isStartedBrokerSocket({ ...previous, isSocket: () => false }, undefined)).toBe(false);
    expect(isStartedBrokerSocket({ ...previous }, previous)).toBe(false);
    expect(isStartedBrokerSocket({ ...previous, ino: 4 }, previous)).toBe(true);
    // Filesystems can immediately reuse an inode; its changed ctime proves replacement too.
    expect(isStartedBrokerSocket({ ...previous, ctimeMs: 4 }, previous)).toBe(true);
  });
});
