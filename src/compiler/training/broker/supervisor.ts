import { chmodSync, chownSync, lstatSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import path from "node:path";

import { SpawnfileError } from "../../../shared/index.js";
import { DAIMON_ORGANIZATION_UID } from "./paths.js";

export const TRAINING_SUPERVISOR_PROTOCOL = "spawnfile.training-slot-supervisor.v1" as const;
export const TRAINING_SUPERVISOR_MAX_REQUEST_BYTES = 4_096;
const NONCE = /^[a-f0-9]{64}$/u;

/**
 * Everything the recycle verb does to the running slot. It is an interface so
 * the state machine below can be tested without Docker, a broker, or root:
 * the order of these calls *is* the contract, and getting it wrong (wiping
 * before draining, writing a receipt before the canaries) is exactly the class
 * of bug a live check finds far too late.
 */
export interface TrainingSlotRuntime {
  /** Waits for no active turn and a settled credential journal; throws a named error on an unrecoverable realm. */
  drain(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  /** Removes worker home, slot workspace, wake-acceptance, turn store, per-slot ledger and Grok session state. */
  wipe(): Promise<void>;
  /** Replays the audited root provisioning: registrations, service.json, worker home, temp, spill, ledgers. */
  provision(): Promise<void>;
  start(): Promise<void>;
  /** Worker-uid denial canaries over every deny path; throws when one is still reachable. */
  canaries(): Promise<{ path: string; method: "sandboxed-read"; result: "denied" }[]>;
  /** Writes the slot preflight receipt v2 atomically, readable by the organization uid. */
  publishReceipt(input: { generation: number; nonce: string; canaries: readonly { path: string; method: "sandboxed-read"; result: "denied" }[] }): Promise<string>;
  /** Monotonic per-slot generation; strictly greater than every generation this slot has ever published. */
  nextGeneration(): Promise<number>;
  log(line: string): void;
}

/**
 * Bringing a slot up, receipt included — the only way this container starts one.
 *
 * `provision → start` alone was the whole start-up path, and `canaries` and
 * `publishReceipt` were reachable only from `recycle`. The first trial of every
 * run therefore executed with no worker-uid denial evidence at all, and a
 * refusal that should have cost nothing surfaced only after that trial's spend.
 * Trial 1 is exactly the trial whose sealed datasets have never been probed, so
 * it is the one that most needs the evidence.
 *
 * The receipt this publishes carries generation 1..N and a nonce of the
 * container's own, so an evaluator that reads `preflight.json` before its first
 * wake sees the same `noopolis.daimon.grok-slot-preflight.v2` shape a recycle
 * publishes, from the same canaries.
 */
export const startTrainingSlot = async (runtime: TrainingSlotRuntime, nonce: string): Promise<{ generation: number; receipt: string; canaries: number }> => {
  await runtime.provision();
  await runtime.start();
  const canaries = await runtime.canaries();
  const generation = await runtime.nextGeneration();
  const receipt = await runtime.publishReceipt({ generation, nonce, canaries });
  runtime.log(`slot start generation=${generation} canaries=${canaries.length} receipt=${receipt}`);
  return { generation, receipt, canaries: canaries.length };
};

export interface TrainingSlotSupervisorOptions {
  runtime: TrainingSlotRuntime;
  /** Only this uid may recycle. Paideia, DSPy and the judges all run as it; every worker uid is refused. */
  organizationUid?: number;
  drainTimeoutMs?: number;
  now?: () => number;
}

export interface TrainingRecycleResult {
  ok: true; verb: "recycle"; generation: number; nonce: string; receipt: string; durationMs: number;
}

/**
 * The single-verb root slot supervisor.
 *
 * One verb, one argument, no path or command ever supplied by the caller: the
 * whole point of D4 is that recycling replays the container's own audited
 * provisioning rather than exposing a root file-system API to the evaluator.
 * Recycles are serialized — a second caller waits rather than interleaving a
 * wipe with a provision.
 */
export const createTrainingSlotSupervisor = (options: TrainingSlotSupervisorOptions) => {
  const organizationUid = options.organizationUid ?? DAIMON_ORGANIZATION_UID;
  const drainTimeoutMs = options.drainTimeoutMs ?? 120_000;
  const now = options.now ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();
  const recycle = async (nonce: string, peerUid: number): Promise<TrainingRecycleResult> => {
    if (peerUid !== organizationUid) throw new SpawnfileError("validation_error", `Grok slot recycle refused for uid ${peerUid}`);
    if (!NONCE.test(nonce)) throw new SpawnfileError("validation_error", "Grok slot recycle requires a 32-byte hex nonce");
    const started = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), drainTimeoutMs);
    try {
      await options.runtime.drain(controller.signal);
    } finally { clearTimeout(timer); }
    await options.runtime.stop();
    await options.runtime.wipe();
    await options.runtime.provision();
    await options.runtime.start();
    const canaries = await options.runtime.canaries();
    const generation = await options.runtime.nextGeneration();
    const receipt = await options.runtime.publishReceipt({ generation, nonce, canaries });
    const durationMs = now() - started;
    options.runtime.log(`recycle generation=${generation} canaries=${canaries.length} durationMs=${durationMs}`);
    return { ok: true, verb: "recycle", generation, nonce, receipt, durationMs };
  };
  return {
    /** Serialized: a recycle already in flight completes before the next one starts. */
    recycle: (nonce: string, peerUid: number): Promise<TrainingRecycleResult> => {
      const next = queue.then(() => recycle(nonce, peerUid));
      queue = next.catch(() => undefined);
      return next;
    }
  };
};

export type TrainingSlotSupervisor = ReturnType<typeof createTrainingSlotSupervisor>;

const failure = (message: string): string => `${JSON.stringify({ v: TRAINING_SUPERVISOR_PROTOCOL, ok: false, error: message })}\n`;

/**
 * Re-establishes, and re-checks on every connection, the only uid gate this
 * socket has.
 *
 * The scope asked for `SO_PEERCRED`. Node exposes no ancillary-data or
 * peer-credential API on a unix socket and no native addon ships in this
 * image, so the gate is the socket node itself, which the kernel enforces on
 * `connect()` exactly as it does on `open()`: the node is
 * `root:<organization gid> 0660` inside a root-owned `0711` directory on
 * tmpfs, where modes *are* enforced. Only uid 2000 (and root) can connect;
 * uid 2200 gets `EACCES` before a byte is written. A `0600` root-owned socket
 * — the literal reading of the scope — would deny the one caller it exists
 * for, so this is the same restriction stated in the only mechanism available.
 * The directory holds no write permission for anyone but root, so the node
 * cannot be replaced by a laxer one.
 */
export const assertTrainingSupervisorSocketIdentity = (socketPath: string, organizationGid: number): void => {
  const directory = lstatSync(path.posix.dirname(socketPath));
  if (!directory.isDirectory() || directory.uid !== 0 || directory.gid !== 0 || (directory.mode & 0o777) !== 0o711) {
    throw new SpawnfileError("runtime_error", "The slot supervisor socket directory must be root-owned 0711");
  }
  const node = lstatSync(socketPath);
  if (!node.isSocket() || node.uid !== 0 || node.gid !== organizationGid || (node.mode & 0o777) !== 0o660) {
    throw new SpawnfileError("runtime_error", "The slot supervisor socket must be root-owned, organization-group 0660");
  }
};

/**
 * Line-delimited JSON over a unix socket. Every request is bounded,
 * single-line, and must name the protocol, the one verb and nothing else.
 */
export const serveTrainingSlotSupervisor = (supervisor: TrainingSlotSupervisor, socketPath: string, log: (line: string) => void, organizationUid = DAIMON_ORGANIZATION_UID) => {
  const server = createServer((socket: Socket) => {
    let peerUid: number | undefined;
    try { assertTrainingSupervisorSocketIdentity(socketPath, organizationUid); peerUid = organizationUid; }
    catch (error) { log(`refusing a connection on an unverified supervisor socket: ${error instanceof Error ? error.message : "unknown"}`); }
    let buffer = "", settled = false;
    socket.setTimeout(600_000, () => socket.destroy());
    const answer = (line: string): void => { settled = true; socket.end(line); };
    socket.on("data", (chunk) => {
      if (settled) return;
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > TRAINING_SUPERVISOR_MAX_REQUEST_BYTES) { answer(failure("request too large")); return; }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      let request: { v?: unknown; verb?: unknown; nonce?: unknown };
      try { request = JSON.parse(line) as typeof request; } catch { answer(failure("request is not JSON")); return; }
      if (request.v !== TRAINING_SUPERVISOR_PROTOCOL || request.verb !== "recycle" || typeof request.nonce !== "string"
        || Object.keys(request).length !== 3) { answer(failure("unsupported request")); return; }
      if (peerUid === undefined) { answer(failure("peer identity is unavailable")); return; }
      supervisor.recycle(request.nonce, peerUid)
        .then((result) => answer(`${JSON.stringify({ v: TRAINING_SUPERVISOR_PROTOCOL, ...result })}\n`))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "recycle failed";
          log(`recycle failed: ${message}`);
          answer(failure(message));
        });
    });
    socket.on("error", () => socket.destroy());
  });
  rmSync(socketPath, { force: true });
  server.listen(socketPath, () => {
    chownSync(socketPath, 0, 0);
    chmodSync(socketPath, 0o660);
    chownSync(socketPath, 0, organizationUid);
    assertTrainingSupervisorSocketIdentity(socketPath, organizationUid);
    log(`slot supervisor listening on ${socketPath}`);
  });
  return server;
};
