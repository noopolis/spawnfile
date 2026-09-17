import { spawn, type ChildProcess } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";

import { SpawnfileError } from "../../../shared/index.js";
import { DAIMON_GROK_ENGINE_BROKER } from "../../../runtime/daimon/contractManifest.js";
import { DAIMON_BROKER_UID, TRAINING_BROKER_TMPDIR } from "./paths.js";

export const DAIMON_RUNTIME_ROOT = "/opt/spawnfile/runtime-installs/daimon";
/** `00000000000000c1` = CHOWN|SETGID|SETUID, the launcher's bounding set after `setpriv`. */
export const LAUNCHER_CAPABILITY_BOUND = "00000000000000c1";
export const DROPPED_CAPABILITY_BOUND = "0000000000000000";

export interface BrokerChild { name: string; pid: number; child: ChildProcess; uid: number; capBnd: string }

const setpriv = (args: string[]): string[] => ["setpriv", ...args];

/**
 * The three broker processes, in the order and with the identities production
 * starts them: the root launcher (which alone may `setuid` to a worker uid),
 * the broker backend as uid 2100, and the native control relay as uid 2100.
 * Each one runs with the same bounding set the production entrypoint verifies,
 * and the broker and relay carry their own `TMPDIR` because shared `/tmp` is
 * closed to every process outside the organization group.
 */
export const brokerProcessPlan = (): { name: string; argv: string[]; socket: string; uid: number; capBnd: string }[] => [
  {
    name: "engine broker launcher", socket: DAIMON_GROK_ENGINE_BROKER.launcherSocketPath, uid: 0, capBnd: LAUNCHER_CAPABILITY_BOUND,
    argv: setpriv(["--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all,+chown,+setuid,+setgid", "--", DAIMON_GROK_ENGINE_BROKER.nativeExecutablePath])
  },
  {
    name: "engine broker backend", socket: DAIMON_GROK_ENGINE_BROKER.backendSocketPath, uid: DAIMON_BROKER_UID, capBnd: DROPPED_CAPABILITY_BOUND,
    argv: setpriv(["--clear-groups", `--reuid=${DAIMON_BROKER_UID}`, `--regid=${DAIMON_BROKER_UID}`, "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all",
      "--", "env", `TMPDIR=${TRAINING_BROKER_TMPDIR}`, `${DAIMON_RUNTIME_ROOT}/bin/daimon-runtime`, "engine-broker", "serve"])
  },
  {
    name: "engine broker control relay", socket: DAIMON_GROK_ENGINE_BROKER.controlSocketPath, uid: DAIMON_BROKER_UID, capBnd: DROPPED_CAPABILITY_BOUND,
    argv: setpriv(["--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all,+chown,+setuid,+setgid,+setpcap", "--", "env", `TMPDIR=${TRAINING_BROKER_TMPDIR}`,
      DAIMON_GROK_ENGINE_BROKER.nativeExecutablePath, "--relay"])
  }
];

const processIdentity = async (pid: number, procRoot: string): Promise<{ uid: string; capBnd: string }> => {
  const status = await readFile(`${procRoot}/${pid}/status`, "utf8");
  return {
    uid: /^Uid:\s+(\d+)/mu.exec(status)?.[1] ?? "",
    capBnd: /^CapBnd:\s+([0-9a-f]+)/mu.exec(status)?.[1] ?? ""
  };
};

export interface StartBrokerOptions {
  timeoutMs?: number;
  pollMs?: number;
  procRoot?: string;
  log(line: string): void;
}

/**
 * Starts all three, then proves each one reached its socket *and* its expected
 * post-drop identity before the next starts. A broker that is alive but still
 * root, or a relay whose socket never appeared, fails the slot here rather
 * than at the first trial wake.
 */
export const startBrokerProcesses = async (options: StartBrokerOptions): Promise<BrokerChild[]> => {
  const timeoutMs = options.timeoutMs ?? 60_000, pollMs = options.pollMs ?? 100, procRoot = options.procRoot ?? "/proc";
  const started: BrokerChild[] = [];
  const deadline = Date.now() + timeoutMs;
  try {
    for (const entry of brokerProcessPlan()) {
      const child = spawn(entry.argv[0]!, entry.argv.slice(1), { stdio: ["ignore", "inherit", "inherit"] });
      if (child.pid === undefined) throw new SpawnfileError("runtime_error", `${entry.name} did not start`);
      let exited = false;
      child.once("exit", (code) => { exited = true; options.log(`${entry.name} exited with status ${code ?? "signal"}`); });
      started.push({ name: entry.name, pid: child.pid, child, uid: entry.uid, capBnd: entry.capBnd });
      for (;;) {
        if (exited) throw new SpawnfileError("runtime_error", `${entry.name} exited before readiness`);
        if (Date.now() > deadline) throw new SpawnfileError("runtime_error", `${entry.name} readiness timed out`);
        const socket = await stat(entry.socket).catch(() => undefined);
        if (socket?.isSocket()) {
          const identity = await processIdentity(child.pid, procRoot);
          if (identity.uid === String(entry.uid) && identity.capBnd === entry.capBnd) break;
        }
        await pause(pollMs);
      }
      options.log(`${entry.name} ready pid=${child.pid} uid=${entry.uid} capbnd=${entry.capBnd}`);
    }
    return started;
  } catch (error) { await stopBrokerProcesses(started, options.log); throw error; }
};

/** Graceful stop in reverse start order: relay, backend, launcher. `SIGKILL` only after the grace window. */
export const stopBrokerProcesses = async (children: readonly BrokerChild[], log: (line: string) => void, graceMs = 5_000): Promise<void> => {
  for (const entry of [...children].reverse()) {
    if (entry.child.exitCode !== null || entry.child.signalCode !== null) continue;
    entry.child.kill("SIGTERM");
    const deadline = Date.now() + graceMs;
    while (entry.child.exitCode === null && entry.child.signalCode === null && Date.now() < deadline) await pause(25);
    if (entry.child.exitCode === null && entry.child.signalCode === null) { log(`${entry.name} did not stop gracefully; killing`); entry.child.kill("SIGKILL"); }
    while (entry.child.exitCode === null && entry.child.signalCode === null) await pause(25);
  }
};
