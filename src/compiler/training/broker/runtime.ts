import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { chmod, chown, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { SpawnfileError } from "../../../shared/index.js";
import type { DaimonGrokRegistration } from "../../containerDaimonGrokWorkerRender.js";
import type { TrainingBrokerDeclaration } from "./declaration.js";
import { MOUNT_AWARE_CLEAR_HELPER } from "../../containerDaimonBrokerRender.js";
import { probeTrainingSiblingClock } from "./clockProbe.js";
import { renderTrainingSlotProvisioning } from "./provisioning.js";
import { buildTrainingSlotReceipt, readGrokExecutableSha256, resolveTrainingCanaries } from "./receipt.js";
import type { TrainingSlotRuntime } from "./supervisor.js";
import {
  DAIMON_ORGANIZATION_UID,
  TRAINING_HOST_BIND_DENY_PATHS,
  TRAINING_SEALED_DENY_PATHS,
  trainingSlotPaths, trainingWipeTargets, trainingClearTargets,
  TRAINING_SUPERVISOR_LOG
} from "./paths.js";

const run = promisify(execFile);
const quote = (value: string): string => `'${value.replace(/'/gu, `'"'"'`)}'`;

export interface TrainingSlotRuntimeOptions {
  declaration: TrainingBrokerDeclaration;
  registration: DaimonGrokRegistration;
  projectionSha256: string;
  reset: (slot: number, signal: AbortSignal) => Promise<void>;
  /** Test seam: the shell the provisioning script runs in and the `/proc` it reads identities from. */
  shell?: string;
  procRoot?: string;
  logPath?: string;
}

export const createTrainingSlotRuntime = (options: TrainingSlotRuntimeOptions): TrainingSlotRuntime => {
  const shell = options.shell ?? "/bin/bash";
  const logPath = options.logPath ?? TRAINING_SUPERVISOR_LOG;
  const p = trainingSlotPaths(options.registration.slot);
  const script = renderTrainingSlotProvisioning(options.registration).join("\n");
  const log = (line: string): void => {
    const entry = `${new Date().toISOString()} ${line}\n`;
    process.stderr.write(`[slot-supervisor] ${entry}`);
    try { appendFileSync(logPath, entry, { mode: 0o640 }); } catch { /* the log is diagnostics, never the gate */ }
  };
  const siblingClocks = Array.from({ length: options.declaration.slots }, (_, slot) => trainingSlotPaths(slot))
    .filter(peer => peer.slot !== p.slot).map(peer => peer.clockDirectory);
  const probe = (target: string, depth: "read" | "enter") => siblingClocks.includes(target)
    ? probeTrainingSiblingClock(p.slot, target)
    : probeTrainingWorker(options.registration.uid, target, depth);
  return {
    log,
    reset: signal => options.reset(p.slot, signal),
    wipe: async () => {
      // Root holds `CAP_CHOWN` and `CAP_DAC_READ_SEARCH` but not `CAP_DAC_OVERRIDE`, so it cannot delete
      // inside a directory it handed to the worker or the broker. Reclaim each tree first, then remove it.
      const script = renderTrainingSlotWipe(p.slot).join("\n");
      await run(shell, ["--noprofile", "--norc", "-ceu", script], { maxBuffer: 1024 * 1024 }).catch((error: unknown) => {
        const detail = error as { stderr?: string };
        throw new SpawnfileError("runtime_error", `Training slot wipe failed: ${(detail.stderr ?? "").slice(-1024).trim() || "no diagnostic"}`);
      });
    },
    provision: async () => {
      const result = await run(shell, ["--noprofile", "--norc", "-ceu", script], { maxBuffer: 8 * 1024 * 1024 }).catch((error: unknown) => {
        const detail = error as { stderr?: string; stdout?: string };
        throw new SpawnfileError("runtime_error", `Training slot provisioning failed: ${(detail.stderr ?? detail.stdout ?? "").slice(-2048).trim()}`);
      });
      if (result.stdout.trim()) log(`provisioning: ${result.stdout.trim().slice(-2048)}`);
    },
    canaries: async () => resolveTrainingCanaries({
      denyPaths: options.registration.denyPaths, probe, log, hostBindPaths: TRAINING_HOST_BIND_DENY_PATHS,
      sealedPaths: TRAINING_SEALED_DENY_PATHS,
      mountinfo: await readFile(`${options.procRoot ?? "/proc"}/self/mountinfo`, "utf8"),
      unenforcedBindPolicy: options.declaration.unenforcedBindPolicy
    }),
    nextGeneration: async () => {
      const previous = await readFile(p.generationFile, "utf8").catch(() => "");
      const parsed = Number.parseInt((JSON.parse(previous || "{}") as { generation?: unknown }).generation as string ?? "0", 10);
      // Seeded from the wall clock so a container restart cannot hand out a generation an evaluator already accepted.
      const generation = Math.max(Number.isSafeInteger(parsed) && parsed > 0 ? parsed + 1 : 1, Math.floor(Date.now() / 1000));
      await writeFile(p.generationFile, `${JSON.stringify({ generation })}\n`, { mode: 0o600 });
      return generation;
    },
    publishReceipt: async ({ generation, nonce, canaries }) => {
      const receipt = buildTrainingSlotReceipt({
        slot: options.registration.slot, workerUid: options.registration.uid, generation, nonce,
        projectionSha256: options.projectionSha256, sandboxProfileSha256: options.registration.profileSha256,
        seccompProfileSha256: options.declaration.seccompProfileSha256,
        grokExecutableSha256: readGrokExecutableSha256(), canaries, createdAt: new Date()
      });
      const temporary = `${p.preflightReceipt}.${randomUUID()}.tmp`;
      await mkdir(path.dirname(p.preflightReceipt), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: "wx" });
      await chown(temporary, 0, DAIMON_ORGANIZATION_UID);
      await chmod(temporary, 0o640);
      await rename(temporary, p.preflightReceipt);
      return p.preflightReceipt;
    }
  };
};

/** Never remove or change the ownership/mode of a worker home or tmp: siblings attest those inodes. */
export const renderTrainingSlotWipe = (slot: number): string[] => {
  const p = trainingSlotPaths(slot);
  const worker = `setpriv --clear-groups --reuid=${p.workerUid} --regid=${p.workerUid} --inh-caps=-all --ambient-caps=-all --bounding-set=-all --`;
  return [
    ...MOUNT_AWARE_CLEAR_HELPER,
    // Attested roots must still be canonical before any recursive mutation.
    ...[p.workerHome, p.privateTmp, ...trainingWipeTargets(slot), ...trainingClearTargets(slot)].map(target =>
      `if [ -e ${quote(target)} ] || [ -L ${quote(target)} ]; then if [ -L ${quote(target)} ] || [ "$(realpath ${quote(target)})" != ${quote(target)} ]; then echo "noncanonical slot wipe target" >&2; exit 1; fi; fi`),
    'reclaim() { parent=$(dirname "$1"); chown 0:0 "$parent"; chmod u+rwx "$parent"; if [ -e "$1" ]; then chown -R 0:0 "$1"; chmod -R u+rwX "$1"; fi; }',
    ...trainingWipeTargets(slot).map(target => `reclaim ${quote(target)}; spawnfile_remove_tree ${quote(target)}`),
    ...trainingClearTargets(slot).map(target => `reclaim ${quote(target)}; spawnfile_clear_tree ${quote(target)}`),
    // Reclaim descendants only, then unlink as the worker, who owns the stable parent. No sibling inode changes.
    `for worker_entry in ${quote(p.workerHome)}/* ${quote(p.workerHome)}/.[!.]* ${quote(p.workerHome)}/..?*; do`,
    '  if [ ! -e "$worker_entry" ] && [ ! -L "$worker_entry" ]; then continue; fi',
    `  if [ "$worker_entry" = ${quote(p.privateTmp)} ]; then continue; fi`,
    '  if spawnfile_holds_mount "$worker_entry"; then echo "worker home contains a mount" >&2; exit 1; fi',
    `  chown -hR ${p.workerUid}:${p.workerUid} "$worker_entry"`,
    `  ${worker} /bin/sh -ceu 'if [ ! -L "$1" ]; then chmod -R u+rwX "$1"; fi; rm -rf "$1"' sh "$worker_entry"`,
    'done',
    `for worker_entry in ${quote(p.privateTmp)}/* ${quote(p.privateTmp)}/.[!.]* ${quote(p.privateTmp)}/..?*; do`,
    '  if [ ! -e "$worker_entry" ] && [ ! -L "$worker_entry" ]; then continue; fi',
    '  if spawnfile_holds_mount "$worker_entry"; then echo "worker tmp contains a mount" >&2; exit 1; fi',
    `  chown -hR ${p.workerUid}:${p.workerUid} "$worker_entry"`,
    `  ${worker} /bin/sh -ceu 'if [ ! -L "$1" ]; then chmod -R u+rwX "$1"; fi; rm -rf "$1"' sh "$worker_entry"`,
    'done'
  ];
};

/** A failed privilege drop is not evidence of denial; require a positive worker verdict. */
export const probeTrainingWorker = async (uid: number, target: string, depth: "read" | "enter",
  execute: (command: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }> = run
): Promise<boolean> => {
  const q = quote(target);
  const reachable = depth === "enter" ? `test -r ${q} || test -x ${q} || ls -1 ${q} >/dev/null 2>&1` : `test -r ${q}`;
  const result = await execute("setpriv", ["--clear-groups", `--reuid=${uid}`, `--regid=${uid}`,
    "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--", "/bin/sh", "-c",
    `if ${reachable}; then echo reachable; else echo denied; fi`], { timeout: 10_000 });
  if (result.stdout.trim() === "denied") return true;
  if (result.stdout.trim() === "reachable") return false;
  throw new SpawnfileError("runtime_error", "Training worker canary returned no verified verdict");
};
