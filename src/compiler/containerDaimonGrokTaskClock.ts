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

/** Lines inside the shared root program, after its canonical-path and ownership helpers. */
export const renderDaimonGrokTaskClockProvisioning = (registrations: readonly DaimonGrokRegistration[]): string[] => {
  if (!registrations.some((entry) => entry.configVariant === "clocked")) return [];
  return [
    `const taskClock = ${JSON.stringify(clock)};`,
    `const clocks = ${JSON.stringify(registrations.filter(entry => entry.configVariant === "clocked").map(entry => ({ directoryPath: clock.slotDirectoryPattern.replace("{slot}", String(entry.slot)), timestampFilePath: clock.slotFilePattern.replace("{slot}", String(entry.slot)) })))};`,
    // All ancestors must stay searchable and non-writable by the worker, including the control root.
    "for (const entry of grokWorkers) { for (let at = require('node:path').dirname(taskClock.rootDirectoryPath);; at = require('node:path').dirname(at)) { const info = assertCanonical(at, 'task clock ancestor'); const access = info.uid === entry.uid ? (info.mode >> 6) & 7 : info.gid === entry.uid ? (info.mode >> 3) & 7 : info.mode & 7; if (!info.isDirectory() || !(access & 1) || (access & 2)) throw new Error(`unsafe task clock ancestor: ${at}`); if (at === '/') break; } }",
    "ensureDirectory(taskClock.rootDirectoryPath, 0, 0, taskClock.directoryMode); assertCanonical(taskClock.rootDirectoryPath, 'task clock root');",
    "for (const current of clocks) { ensureDirectory(current.directoryPath, 0, 0, taskClock.directoryMode); assertCanonical(current.directoryPath, 'task clock');",
    "ensureExactFile(current.timestampFilePath, '+0\\n', taskClock.fileMode); fs.chownSync(current.timestampFilePath, taskClock.ownerUid, taskClock.ownerUid);",
    "withMode(current.directoryPath, taskClock.directoryMode, taskClock.ownerUid, taskClock.ownerUid); }",
    // Startup attestation runs BEFORE the backend listens. All deny targets must already exist,
    // and the backend only replaces a socket owned by its uid. Listeners unlink these real socket
    // nodes in turn; readiness must prove replacement, never certify a placeholder as a listener.
    `for (const socket of ${JSON.stringify([broker.controlSocketPath, broker.backendSocketPath, broker.launcherSocketPath])}) { require('node:child_process').execFileSync(process.execPath, ['-e', ${JSON.stringify(GROK_SOCKET_PLACEHOLDER_PROGRAM)}, socket, '${clock.ownerUid}', '${clock.ownerUid}'], { timeout: 5000, stdio: 'pipe' }); const info = fs.lstatSync(socket); if (!info.isSocket() || info.uid !== ${clock.ownerUid} || info.gid !== ${clock.ownerUid} || (info.mode & 0o7777) !== 0o600) throw new Error('unsafe broker socket placeholder'); }`
  ];
};
