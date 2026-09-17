import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { chmod, chown, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { promisify } from "node:util";

import { SpawnfileError } from "../../../shared/index.js";
import { DAIMON_GROK_ENGINE_BROKER } from "../../../runtime/daimon/contractManifest.js";
import type { DaimonGrokRegistration } from "../../containerDaimonGrokWorkerRender.js";
import type { TrainingBrokerDeclaration } from "./declaration.js";
import { renderTrainingBrokerProvisioning, renderTrainingIdentities } from "./provisioning.js";
import { startBrokerProcesses, stopBrokerProcesses, type BrokerChild } from "./processes.js";
import { buildTrainingSlotReceipt, readGrokExecutableSha256, resolveTrainingCanaries } from "./receipt.js";
import type { TrainingSlotRuntime } from "./supervisor.js";
import {
  DAIMON_ORGANIZATION_UID,
  TRAINING_SLOT_ACCEPTANCE_STORE,
  TRAINING_SLOT_GENERATION_FILE,
  TRAINING_SLOT_PREFLIGHT_RECEIPT,
  TRAINING_SLOT_TURN_STORE,
  TRAINING_SLOT_USAGE_DIRECTORY,
  TRAINING_SLOT_WORKSPACE,
  TRAINING_SUPERVISOR_LOG
} from "./paths.js";

const run = promisify(execFile);

export interface TrainingSlotRuntimeOptions {
  declaration: TrainingBrokerDeclaration;
  registration: DaimonGrokRegistration;
  projectionSha256: string;
  /** Test seam: the shell the provisioning script runs in and the `/proc` it reads identities from. */
  shell?: string;
  procRoot?: string;
  logPath?: string;
}

const CREDENTIAL_JOURNAL = `${DAIMON_GROK_ENGINE_BROKER.credentialHomePath}/.daimon-broker/credential-journal.json`;

/** State the broker's credential authority may be left in; only `promoted` (or no journal at all) is settled. */
const settledJournal = async (): Promise<"settled" | "refreshing" | "stale"> => {
  const raw = await readFile(CREDENTIAL_JOURNAL, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (raw === undefined) return "settled";
  const journal = JSON.parse(raw) as { version?: unknown; state?: unknown };
  if (journal.version !== "noopolis.daimon.broker-credential-journal.v1") throw new SpawnfileError("runtime_error", "The broker credential journal is not a recognised version");
  return journal.state === "promoted" ? "settled" : journal.state === "refreshing" ? "refreshing" : "stale";
};

/** A turn is active while its registry record says so; a terminal record is finished work and never blocks a recycle. */
const activeTurns = async (): Promise<number> => {
  const names = await readdir(TRAINING_SLOT_TURN_STORE).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  let active = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const raw = await readFile(path.join(TRAINING_SLOT_TURN_STORE, name), "utf8").catch(() => "");
    try { if ((JSON.parse(raw) as { state?: unknown }).state === "active") active += 1; } catch { /* a half-written record is not an active turn */ }
  }
  return active;
};

/**
 * The real slot runtime: what `recycle` actually does to this container.
 *
 * Every mutation goes through the same rendered provisioning the root
 * entrypoint ran at startup, so a recycled slot is byte-identically
 * provisioned — including the credential journal recovery, which is how a
 * recycle that lands on a `refreshing` or `stale` realm either recovers or
 * fails closed with a named error instead of leaving a silently stale realm.
 */
export const createTrainingSlotRuntime = (options: TrainingSlotRuntimeOptions): TrainingSlotRuntime & { children(): readonly BrokerChild[] } => {
  const shell = options.shell ?? "/bin/bash";
  const logPath = options.logPath ?? TRAINING_SUPERVISOR_LOG;
  const script = [...renderTrainingIdentities(), ...renderTrainingBrokerProvisioning(options.registration)].join("\n");
  let children: BrokerChild[] = [];
  const log = (line: string): void => {
    const entry = `${new Date().toISOString()} ${line}\n`;
    process.stderr.write(`[slot-supervisor] ${entry}`);
    try { appendFileSync(logPath, entry, { mode: 0o640 }); } catch { /* the log is diagnostics, never the gate */ }
  };
  const probe = async (target: string): Promise<boolean> => {
    try {
      await run("setpriv", ["--clear-groups", `--reuid=${options.registration.uid}`, `--regid=${options.registration.uid}`,
        "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--", "/bin/sh", "-c", `exec test -r ${JSON.stringify(target)}`], { timeout: 10_000 });
      return false;
    } catch { return true; }
  };
  return {
    log,
    children: () => children,
    drain: async (signal) => {
      for (;;) {
        signal.throwIfAborted();
        const state = await settledJournal();
        if (state === "stale") {
          // The audited provisioning below owns stale-realm recovery; it promotes the bootstrap or refuses outright.
          log("credential journal is stale; the recycle will replay the root credential recovery");
          return;
        }
        if (state === "settled" && await activeTurns() === 0) return;
        await pause(100);
      }
    },
    stop: async () => { await stopBrokerProcesses(children, log); children = []; },
    wipe: async () => {
      for (const target of [options.registration.home, TRAINING_SLOT_TURN_STORE, TRAINING_SLOT_ACCEPTANCE_STORE,
        options.registration.spillDirectory, DAIMON_GROK_ENGINE_BROKER.serviceConfigPath, DAIMON_GROK_ENGINE_BROKER.registrationPath]) {
        await rm(target, { recursive: true, force: true });
      }
      // The workspace keeps its root; only the trial's content goes, so the registered path stays canonical.
      for (const name of await readdir(TRAINING_SLOT_WORKSPACE).catch(() => [] as string[])) {
        await rm(path.join(TRAINING_SLOT_WORKSPACE, name), { recursive: true, force: true });
      }
      for (const name of await readdir(TRAINING_SLOT_USAGE_DIRECTORY).catch(() => [] as string[])) {
        await rm(path.join(TRAINING_SLOT_USAGE_DIRECTORY, name), { recursive: true, force: true });
      }
    },
    provision: async () => {
      const result = await run(shell, ["-ceu", script], { maxBuffer: 8 * 1024 * 1024 }).catch((error: unknown) => {
        const detail = error as { stderr?: string; stdout?: string };
        throw new SpawnfileError("runtime_error", `Training slot provisioning failed: ${(detail.stderr ?? detail.stdout ?? "").slice(-2048).trim()}`);
      });
      if (result.stdout.trim()) log(`provisioning: ${result.stdout.trim().slice(-2048)}`);
    },
    start: async () => { children = await startBrokerProcesses({ log, procRoot: options.procRoot }); },
    canaries: async () => resolveTrainingCanaries({
      denyPaths: options.registration.denyPaths, probe, log,
      mountinfo: await readFile(`${options.procRoot ?? "/proc"}/self/mountinfo`, "utf8"),
      unenforcedBindPolicy: options.declaration.unenforcedBindPolicy
    }),
    nextGeneration: async () => {
      const previous = await readFile(TRAINING_SLOT_GENERATION_FILE, "utf8").catch(() => "");
      const parsed = Number.parseInt((JSON.parse(previous || "{}") as { generation?: unknown }).generation as string ?? "0", 10);
      // Seeded from the wall clock so a container restart cannot hand out a generation an evaluator already accepted.
      const generation = Math.max(Number.isSafeInteger(parsed) && parsed > 0 ? parsed + 1 : 1, Math.floor(Date.now() / 1000));
      await writeFile(TRAINING_SLOT_GENERATION_FILE, `${JSON.stringify({ generation })}\n`, { mode: 0o600 });
      return generation;
    },
    publishReceipt: async ({ generation, nonce, canaries }) => {
      const receipt = buildTrainingSlotReceipt({
        slot: options.registration.slot, workerUid: options.registration.uid, generation, nonce,
        projectionSha256: options.projectionSha256, sandboxProfileSha256: options.registration.profileSha256,
        seccompProfileSha256: options.declaration.seccompProfileSha256,
        grokExecutableSha256: readGrokExecutableSha256(), canaries, createdAt: new Date()
      });
      const temporary = `${TRAINING_SLOT_PREFLIGHT_RECEIPT}.${randomUUID()}.tmp`;
      await mkdir(path.dirname(TRAINING_SLOT_PREFLIGHT_RECEIPT), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: "wx" });
      await chown(temporary, 0, DAIMON_ORGANIZATION_UID);
      await chmod(temporary, 0o640);
      await rename(temporary, TRAINING_SLOT_PREFLIGHT_RECEIPT);
      return TRAINING_SLOT_PREFLIGHT_RECEIPT;
    }
  };
};
