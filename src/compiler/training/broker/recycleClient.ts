import { createConnection, type Socket } from "node:net";

import { SpawnfileError } from "../../../shared/index.js";
import { TRAINING_MAX_SLOTS, TRAINING_SUPERVISOR_SOCKET } from "./paths.js";
import { TRAINING_SUPERVISOR_PROTOCOL } from "./supervisor.js";

/** A reply is one short JSON line; anything longer is not this supervisor. */
export const TRAINING_RECYCLE_MAX_REPLY_BYTES = 65_536;
/** Above the supervisor's 120 s drain deadline plus wipe, provision and canaries. */
export const TRAINING_RECYCLE_DEFAULT_TIMEOUT_MS = 180_000;
const NONCE = /^[a-f0-9]{64}$/u;
const REPLY_KEYS = ["durationMs", "generation", "nonce", "ok", "receipt", "slot", "v", "verb"];

export interface RecycleTrainingSlotOptions {
  slot: number;
  /** This trial's 32-byte hex nonce; the published receipt must echo it. */
  nonce: string;
  signal?: AbortSignal;
  /** Opens the supervisor connection; defaults to the container's fixed supervisor socket. */
  connect?: () => Socket;
  timeoutMs?: number;
}

export interface TrainingSlotRecycleReceipt {
  slot: number;
  generation: number;
  nonce: string;
  /** The receipt path the supervisor says it published; callers compare it to the slot descriptor. */
  receipt: string;
  durationMs: number;
}

const refuse = (message: string): SpawnfileError => new SpawnfileError("runtime_error", message);

/** The supervisor's refusal text is diagnostic only; keep it one bounded printable line. */
const refusalText = (value: unknown): string =>
  typeof value === "string" ? value.replace(/[^\x20-\x7e]/gu, "?").slice(0, 512) || "unknown" : "unknown";

const bindReply = (answer: Record<string, unknown>, slot: number, nonce: string): TrainingSlotRecycleReceipt => {
  if (answer.ok !== true) throw refuse(`Training slot ${slot} recycle refused: ${refusalText(answer.error)}`);
  if (Object.keys(answer).sort().join(",") !== REPLY_KEYS.join(",") || answer.verb !== "recycle") {
    throw refuse("Training slot recycle answer is not a recycle receipt");
  }
  if (answer.slot !== slot) throw refuse(`Training slot recycle answer names slot ${String(answer.slot)}, not the leased slot ${slot}`);
  if (answer.nonce !== nonce) throw refuse("Training slot recycle answer does not echo this trial's nonce");
  if (!Number.isSafeInteger(answer.generation) || (answer.generation as number) < 1) {
    throw refuse("Training slot recycle answer carries no valid generation");
  }
  if (typeof answer.receipt !== "string" || answer.receipt.length === 0) throw refuse("Training slot recycle answer names no receipt");
  if (typeof answer.durationMs !== "number" || !Number.isFinite(answer.durationMs) || answer.durationMs < 0) {
    throw refuse("Training slot recycle answer carries no valid duration");
  }
  return { slot, generation: answer.generation as number, nonce, receipt: answer.receipt, durationMs: answer.durationMs };
};

/**
 * One `recycle` over the root slot supervisor socket (`spawnfile.training-slot-supervisor.v2`).
 *
 * The verb takes a slot and a nonce, never a path or a command: the container
 * replays its own audited provisioning and publishes the slot preflight receipt
 * echoing this nonce. The answer must bind this request exactly (protocol,
 * verb, slot, nonce, a generation of at least 1) or it is refused; a supervisor
 * refusal surfaces with its own reason. The reply is bounded, and the call is
 * bounded by `timeoutMs` and `signal`.
 */
export const recycleTrainingSlot = (options: RecycleTrainingSlotOptions): Promise<TrainingSlotRecycleReceipt> => {
  const { slot, nonce } = options;
  if (!Number.isInteger(slot) || slot < 0 || slot >= TRAINING_MAX_SLOTS) {
    return Promise.reject(new SpawnfileError("validation_error", `Training slot recycle requires a slot index from 0 to ${TRAINING_MAX_SLOTS - 1}`));
  }
  if (!NONCE.test(nonce)) return Promise.reject(new SpawnfileError("validation_error", "Training slot recycle requires a 32-byte hex nonce"));
  try { options.signal?.throwIfAborted(); } catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const socket = (options.connect ?? (() => createConnection(TRAINING_SUPERVISOR_SOCKET)))();
    let buffer = Buffer.alloc(0), settled = false;
    const onAbort = (): void => finish(options.signal?.reason instanceof Error ? options.signal.reason : refuse("Training slot recycle was aborted"));
    const timer = setTimeout(() => finish(refuse(`Training slot ${slot} recycle timed out before the supervisor answered`)),
      options.timeoutMs ?? TRAINING_RECYCLE_DEFAULT_TIMEOUT_MS);
    function finish(error?: unknown, value?: TrainingSlotRecycleReceipt): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error === undefined) resolve(value!); else reject(error);
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("error", (error: Error) => finish(refuse(`Training slot recycle could not reach the root supervisor: ${error.message}`)));
    socket.on("close", () => finish(refuse("Training slot recycle connection closed before an answer")));
    socket.on("connect", () => socket.write(`${JSON.stringify({ v: TRAINING_SUPERVISOR_PROTOCOL, verb: "recycle", slot, nonce })}\n`));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(0x0a);
      if (end < 0 ? buffer.length > TRAINING_RECYCLE_MAX_REPLY_BYTES : end > TRAINING_RECYCLE_MAX_REPLY_BYTES) {
        finish(refuse("Training slot recycle answer exceeded its bound")); return;
      }
      if (end < 0) return;
      let answer: unknown;
      try { answer = JSON.parse(buffer.subarray(0, end).toString("utf8")); }
      catch { finish(refuse("Training slot recycle answer is not JSON")); return; }
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) { finish(refuse("Training slot recycle answer is not an object")); return; }
      const record = answer as Record<string, unknown>;
      if (record.v !== TRAINING_SUPERVISOR_PROTOCOL) { finish(refuse("Training slot recycle answer names another protocol")); return; }
      try { finish(undefined, bindReply(record, slot, nonce)); } catch (error) { finish(error); }
    });
  });
};
