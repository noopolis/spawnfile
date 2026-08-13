import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = process.argv[2];
if (typeof directory !== "string") process.exit(1);
const stat = await lstat(directory).catch(() => undefined);
if (!stat?.isDirectory()) process.exit(1);
const worker = fork(fileURLToPath(new URL("./organizationHandoffAuthorityFsWorker.ts", import.meta.url)), [], {
  cwd: directory,
  env: { SPAWNFILE_AUTHORITY_FS_ANCHOR: JSON.stringify({ dev: stat.dev, ino: stat.ino, uid: typeof process.getuid === "function" ? process.getuid() : undefined, parent_pid: process.pid }) },
  execArgv: ["--import", createRequire(import.meta.url).resolve("tsx")],
  silent: true
});
worker.stdout?.resume(); worker.stderr?.resume();
worker.once("message", (message: unknown) => {
  if ((message as { ready?: unknown } | null)?.ready !== true || typeof process.send !== "function") process.exit(1);
  process.send({ worker_pid: worker.pid });
});
// Keep the fixture parent alive until the test kills it; the worker must then
// notice its changed ppid and exit on its own.
setInterval(() => undefined, 1_000);
