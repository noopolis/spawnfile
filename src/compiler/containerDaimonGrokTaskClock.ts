import { SpawnfileError } from "../shared/index.js";
import { DAIMON_GROK_ENGINE_BROKER } from "../runtime/daimon/contractManifest.js";
import type { DaimonGrokRegistration } from "./containerDaimonGrokWorkerRender.js";

const broker = DAIMON_GROK_ENGINE_BROKER;
const clock = broker.worker.taskClock;

/** Exit without closing/unlinking the listener: the next process needs a socket inode, not a live peer. */
export const GROK_SOCKET_PLACEHOLDER_PROGRAM = [
  "const fs = require('node:fs'), net = require('node:net');",
  "const [file, uid, gid] = process.argv.slice(1);",
  "const server = net.createServer(); server.on('error', (error) => { console.error(error.message); process.exit(1); });",
  "server.listen(file, () => { fs.chmodSync(file, 0o600); fs.chownSync(file, Number(uid), Number(gid)); process.exit(0); });"
].join("\n");

/** A fixed clock file cannot serve concurrent registrations, even mixed variants. */
export const grokProvisioningConfigPins = (registrations: readonly DaimonGrokRegistration[]) => {
  if (!registrations.some((entry) => entry.workerConfigVariant === "clocked")) return broker.worker.configSha256;
  if (registrations.length !== clock.maxRegistrations) {
    throw new SpawnfileError("compile_error", "Clocked Grok slots require exactly one registration");
  }
  return broker.worker.clockedConfigSha256;
};

/** Lines inside the shared root program, after its canonical-path and ownership helpers. */
export const renderDaimonGrokTaskClockProvisioning = (registrations: readonly DaimonGrokRegistration[]): string[] => {
  grokProvisioningConfigPins(registrations);
  if (!registrations.some((entry) => entry.workerConfigVariant === "clocked")) return [];
  return [
    `const taskClock = ${JSON.stringify(clock)};`,
    // All ancestors must stay searchable and non-writable by the worker, including the control root.
    "for (const entry of grokWorkers) { for (let at = require('node:path').dirname(taskClock.directoryPath);; at = require('node:path').dirname(at)) { const info = assertCanonical(at, 'task clock ancestor'); const access = info.uid === entry.uid ? (info.mode >> 6) & 7 : info.gid === entry.uid ? (info.mode >> 3) & 7 : info.mode & 7; if (!info.isDirectory() || !(access & 1) || (access & 2)) throw new Error(`unsafe task clock ancestor: ${at}`); if (at === '/') break; } }",
    "ensureDirectory(taskClock.directoryPath, 0, 0, taskClock.directoryMode); assertCanonical(taskClock.directoryPath, 'task clock');",
    "ensureExactFile(taskClock.timestampFilePath, '+0\\n', taskClock.fileMode); fs.chownSync(taskClock.timestampFilePath, taskClock.ownerUid, taskClock.ownerUid);",
    "withMode(taskClock.directoryPath, taskClock.directoryMode, taskClock.ownerUid, taskClock.ownerUid);",
    // Startup attestation runs BEFORE the backend listens. All deny targets must already exist,
    // and the backend only replaces a socket owned by its uid. Listeners unlink these real socket
    // nodes in turn; readiness must prove replacement, never certify a placeholder as a listener.
    `for (const socket of ${JSON.stringify([broker.controlSocketPath, broker.backendSocketPath, broker.launcherSocketPath])}) { require('node:child_process').execFileSync(process.execPath, ['-e', ${JSON.stringify(GROK_SOCKET_PLACEHOLDER_PROGRAM)}, socket, '${clock.ownerUid}', '${clock.ownerUid}'], { timeout: 5000, stdio: 'pipe' }); const info = fs.lstatSync(socket); if (!info.isSocket() || info.uid !== ${clock.ownerUid} || info.gid !== ${clock.ownerUid} || (info.mode & 0o7777) !== 0o600) throw new Error('unsafe broker socket placeholder'); }`
  ];
};
