import { fork, type ChildProcess } from "node:child_process";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { initializeOrganizationHandoffAuthorityFsClient } from "./organizationHandoffAuthorityFsClient.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

it("disposes promptly and idempotently after a worker has already exited by signal", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-handoff-fs-client-")); directories.push(directory);
  const stat = await lstat(directory); let child: ChildProcess | undefined;
  const client = await initializeOrganizationHandoffAuthorityFsClient({ cwd: directory, dev: stat.dev, ino: stat.ino,
    ...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}), testOnChildStarted: (started) => { child = started; } });
  if (!child) throw new Error("worker did not start");
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child?.exitCode !== null || child?.signalCode !== null ? resolve() : child?.once("exit", () => resolve()));
  await Promise.race([client.dispose(), new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("dispose did not settle")), 500))]);
  await client.dispose();
});

it("reaches readiness when startup is stalled past a liveness watchdog tick", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-handoff-fs-client-")); directories.push(directory);
  const stat = await lstat(directory);
  const require = createRequire(import.meta.url);
  // Fork the worker directly: the stall has to be injected into the helper's
  // own startup, which the client API deliberately does not expose.
  const worker = fork(fileURLToPath(new URL("./organizationHandoffAuthorityFsWorker.ts", import.meta.url)), [], {
    cwd: directory,
    env: {
      SPAWNFILE_AUTHORITY_FS_ANCHOR: JSON.stringify({
        dev: stat.dev, ino: stat.ino,
        ...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
        parent_pid: process.pid
      }),
      // One threadpool slot, held by the stall preload, so the anchor lstat
      // cannot complete before the watchdog ticks.
      UV_THREADPOOL_SIZE: "1"
    },
    execArgv: [
      "--import", require.resolve("tsx"),
      "--import", fileURLToPath(new URL("./organizationHandoffAuthorityFsWorkerStall.fixture.ts", import.meta.url))
    ],
    silent: true
  });
  worker.stdout?.resume(); worker.stderr?.resume();
  try {
    const outcome = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), 10_000);
      worker.on("message", (raw: unknown) => {
        if ((raw as { ready?: unknown } | null)?.ready === true) { clearTimeout(timer); resolve("ready"); }
      });
      worker.once("exit", (code, signal) => { clearTimeout(timer); resolve(`exit:${String(code)}:${String(signal)}`); });
    });
    // A watchdog that treats "not yet ready" as "orphaned" reaps the helper
    // here with a clean exit(0) before it can ever report readiness.
    expect(outcome).toBe("ready");
  } finally {
    worker.kill("SIGKILL");
    await new Promise<void>((resolve) => { worker.exitCode !== null || worker.signalCode !== null ? resolve() : worker.once("exit", () => resolve()); });
  }
});

it("converges full-size concurrent publishers without leaving staging sidecars", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-handoff-fs-client-")); directories.push(directory);
  const stat = await lstat(directory);
  const options = {
    cwd: directory, dev: stat.dev, ino: stat.ino,
    ...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
  };
  const clients = await Promise.all(Array.from({ length: 8 }, async () => initializeOrganizationHandoffAuthorityFsClient(options)));
  const leaves: string[] = [];
  try {
    for (let index = 0; index < 8; index += 1) {
      const name = `${index.toString(16).padStart(128, "0")}.json`; leaves.push(name);
      const results = await Promise.all(clients.map(async (client) => client.create(name, "x".repeat(30_000))));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await readdir(directory)).sort()).toEqual([...leaves].sort());
    }
  } finally {
    await Promise.all(clients.map(async (client) => client.dispose()));
  }
});

it("reports which request the worker rejected and why", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-handoff-fs-client-")); directories.push(directory);
  const stat = await lstat(directory);
  const client = await initializeOrganizationHandoffAuthorityFsClient({
    cwd: directory, dev: stat.dev, ino: stat.ino,
    ...(typeof process.getuid === "function" ? { uid: process.getuid() } : {})
  });
  const name = `${"a".repeat(128)}.json`;
  try {
    expect(await client.read(name)).toBeNull();
    expect(await client.create(name, "first")).toBe(true);
    expect(await client.create(name, "first")).toBe(false);
    // The record is immutable, so a conflicting publication must fail — and
    // must say which invariant refused it rather than reporting a bare failure.
    await expect(client.create(name, "second")).rejects.toThrow(/existing_content_mismatch.*op=create/u);
  } finally {
    await client.dispose();
  }
});

it("names the client-side limit it refused a request against", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-handoff-fs-client-")); directories.push(directory);
  const stat = await lstat(directory);
  const client = await initializeOrganizationHandoffAuthorityFsClient({
    cwd: directory, dev: stat.dev, ino: stat.ino,
    ...(typeof process.getuid === "function" ? { uid: process.getuid() } : {})
  });
  const name = `${"b".repeat(128)}.json`;
  try {
    await expect(client.create("not-a-record-name", "x")).rejects.toThrow("invalid_name");
    await expect(client.create(name, "x".repeat(32_769))).rejects.toThrow(/content_too_large.*limit=32768/u);
    await expect(client.create(name, "x".repeat(32_700))).rejects.toThrow(/packet_too_large/u);
  } finally {
    await client.dispose();
  }
  await expect(client.read(name)).rejects.toThrow("client_closed");
});
