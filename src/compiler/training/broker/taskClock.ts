import { DAIMON_GROK_ENGINE_BROKER } from "../../../runtime/daimon/contractManifest.js";
import { SpawnfileError } from "../../../shared/index.js";
import type { DaimonGrokRegistration } from "../../containerDaimonGrokWorkerRender.js";

const clock = DAIMON_GROK_ENGINE_BROKER.worker.taskClock;
const quote = (value: string): string => `'${value.replace(/'/gu, `'"'"'`)}'`;

/** Reclaim only the clock subtree before the shared program clears the control root on recycle. */
export const renderTrainingTaskClockReset = (): string[] => [
  `test ! -L ${quote(clock.directoryPath)}`,
  `if [ -d ${quote(clock.directoryPath)} ]; then chown -R 0:0 ${quote(clock.directoryPath)}; chmod -R u+rwX ${quote(clock.directoryPath)}; fi`
];

/** Before a receipt, bind the actual installed bytes and worker access to the clocked projection. */
export const renderTrainingTaskClockAssertions = (registration: DaimonGrokRegistration): string[] => {
  const pin = DAIMON_GROK_ENGINE_BROKER.worker.clockedConfigSha256[registration.model][registration.reasoningEffort];
  if (registration.workerConfigVariant !== "clocked" || registration.configSha256 !== pin) {
    throw new SpawnfileError("runtime_error", "Training slot requires the pinned clocked worker config");
  }
  const worker = [
    `test -r ${quote(clock.timestampFilePath)}`, `test ! -w ${quote(clock.timestampFilePath)}`,
    `test -x ${quote(clock.directoryPath)}`, `test ! -w ${quote(clock.directoryPath)}`,
    `test -r ${quote(clock.preloadPath)}`
  ].join(" && ");
  return [
    `test ! -L ${quote(clock.directoryPath)} && test -d ${quote(clock.directoryPath)}`,
    `test ! -L ${quote(clock.timestampFilePath)} && test -f ${quote(clock.timestampFilePath)}`,
    `test "$(stat -c '%u:%g %a' ${quote(clock.directoryPath)})" = "${clock.ownerUid}:${clock.ownerUid} ${clock.directoryMode.toString(8)}"`,
    `test "$(stat -c '%u:%g %a %h' ${quote(clock.timestampFilePath)})" = "${clock.ownerUid}:${clock.ownerUid} ${clock.fileMode.toString(8)} 1"`,
    `test "$(sha256sum ${quote(`${registration.grokHome}/config.toml`)} | cut -d ' ' -f1)" = ${quote(pin)}`,
    // The read-only image bakes both the fixed symlink and the distro target. Refuse writable or
    // non-root-owned ancestors/targets; a missing library must never masquerade as a working clock.
    "node <<'SPAWNFILE_TASK_CLOCK_LIBRARY'",
    "const fs = require('node:fs'), path = require('node:path');",
    `const preload = ${JSON.stringify(clock.preloadPath)};`,
    "const link = fs.lstatSync(preload); if (!link.isSymbolicLink() || link.uid !== 0 || link.gid !== 0) throw new Error('unsafe task clock preload link');",
    "const library = fs.realpathSync(preload); if (!/^\\/usr\\/lib\\/(x86_64|aarch64)-linux-gnu\\/faketime\\/libfaketime\\.so\\.1$/.test(library) || !fs.statSync(library).isFile()) throw new Error('unexpected task clock library');",
    "for (const root of [path.dirname(preload), library]) { for (let at = root;; at = path.dirname(at)) { const info = fs.lstatSync(at); if (info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o022)) throw new Error(`unsafe task clock library path: ${at}`); if (at === '/') break; } }",
    "SPAWNFILE_TASK_CLOCK_LIBRARY",
    `setpriv --clear-groups --reuid ${registration.uid} --regid ${registration.uid} --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- /bin/sh -ceu ${quote(worker)}`
  ];
};
