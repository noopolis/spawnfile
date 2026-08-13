import type { ChildProcess } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
