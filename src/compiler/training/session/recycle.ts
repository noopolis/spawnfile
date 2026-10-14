import { createConnection } from "node:net";
import { z } from "zod";
import { TRAINING_SUPERVISOR_PROTOCOL } from "../broker/supervisor.js";
import { TRAINING_SUPERVISOR_SOCKET } from "../broker/paths.js";

const responseSchema = z.object({
  v: z.literal(TRAINING_SUPERVISOR_PROTOCOL), ok: z.literal(true), verb: z.literal("recycle"),
  slot: z.number().int().min(0).max(7), generation: z.number().int().positive(),
  nonce: z.string().regex(/^[a-f0-9]{64}$/u), receipt: z.string().min(1), durationMs: z.number().nonnegative()
}).strict();
export type TrainingSessionRecycle = Omit<z.infer<typeof responseSchema>, "v">;

/** The root supervisor alone drains, wipes, provisions and attests a slot. */
export const recycleTrainingSessionSlot = (slot: number, nonce: string, signal: AbortSignal,
  connect = createConnection, socketPath = TRAINING_SUPERVISOR_SOCKET): Promise<TrainingSessionRecycle> => {
  if (!Number.isInteger(slot) || slot < 0 || slot > 7 || !/^[a-f0-9]{64}$/u.test(nonce)) throw Error("Invalid slot recycle identity");
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "", settled = false;
    const finish = (error?: unknown, result?: TrainingSessionRecycle) => {
      if (settled) return;
      settled = true; signal.removeEventListener("abort", abort); socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(Error("Slot recycle aborted; quarantine the lease"));
    signal.addEventListener("abort", abort, { once: true });
    socket.setTimeout(180_000, () => finish(Error("Slot recycle deadline exceeded; quarantine the lease")));
    socket.once("error", error => finish(error));
    socket.once("close", () => finish(Error("Slot recycle closed before acknowledgement")));
    socket.once("connect", () => socket.write(`${JSON.stringify({ v: TRAINING_SUPERVISOR_PROTOCOL, verb: "recycle", slot, nonce })}\n`));
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > 4096) { finish(Error("Slot recycle response exceeds bound")); return; }
      if (!buffer.includes("\n")) return;
      try {
        if (buffer.slice(buffer.indexOf("\n") + 1).trim()) throw Error("Unexpected trailing recycle response");
        const result = responseSchema.parse(JSON.parse(buffer.trim()));
        if (result.slot !== slot || result.nonce !== nonce) throw Error("Slot recycle acknowledgement differs from this lease");
        const { v: _version, ...receipt } = result;
        finish(undefined, receipt);
      } catch (error) { finish(error); }
    });
    if (signal.aborted) abort();
  });
};
