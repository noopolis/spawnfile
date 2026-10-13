import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { DAIMON_GROK_ENGINE_BROKER } from "../../../runtime/daimon/contractManifest.js";
import { trainingSlotPaths } from "./paths.js";

/** Root uses the broker's slot reset seam; the broker owns active-turn, worker-reap and clock checks. */
export const resetTrainingBrokerSlot = (slot: number, signal: AbortSignal,
  socketPath = DAIMON_GROK_ENGINE_BROKER.controlSocketPath): Promise<void> => {
  trainingSlotPaths(slot);
  signal.throwIfAborted();
  const requestId = randomUUID();
  const version = DAIMON_GROK_ENGINE_BROKER.controlProtocolVersion;
  const payload = Buffer.from(JSON.stringify({ version, kind: "reset_slot", requestId, slot }));
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32BE(payload.length); payload.copy(frame, 4);
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = Buffer.alloc(0), settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; signal.removeEventListener("abort", abort); socket.destroy();
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(new Error("Training broker reset aborted; slot must be quarantined"));
    signal.addEventListener("abort", abort, { once: true });
    socket.once("error", error => finish(error));
    socket.once("close", () => finish(new Error("Training broker reset refused: slot active, unavailable, or reset failed")));
    socket.once("connect", () => socket.write(frame));
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const size = buffer.readUInt32BE(0);
      if (size < 2 || size > 4096 || buffer.length > size + 4) { finish(new Error("Invalid broker reset response frame")); return; }
      if (buffer.length < size + 4) return;
      try {
        const response = JSON.parse(buffer.subarray(4).toString("utf8"));
        if (!response || response.version !== version || response.kind !== "slot_reset" || response.requestId !== requestId
          || response.slot !== slot || Object.keys(response).length !== 4) throw Error("Invalid broker reset acknowledgement");
        finish();
      } catch (error) { finish(error instanceof Error ? error : new Error("Invalid broker reset response")); }
    });
  });
};

/** The native control relay authenticates SO_PEERCRED uid 2000 and rejects root. */
export const resetTrainingBrokerSlotAsOrganization = async (slot: number, signal: AbortSignal,
  execute: (file: string, args: string[], options: { signal: AbortSignal; timeout: number }) => Promise<{ stdout: string }> = promisify(execFile)
): Promise<void> => {
  trainingSlotPaths(slot);
  signal.throwIfAborted();
  const uid = DAIMON_GROK_ENGINE_BROKER.identities.organizationUid;
  const program = `import { resetTrainingBrokerSlot } from ${JSON.stringify(import.meta.url)}; await resetTrainingBrokerSlot(Number(process.argv[1]), AbortSignal.timeout(10000)); process.stdout.write("slot-reset-complete\\n");`;
  const result = await execute("setpriv", ["--clear-groups", `--reuid=${uid}`, `--regid=${uid}`,
    "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--", process.execPath,
    "--input-type=module", "--eval", program, String(slot)], { signal, timeout: 15_000 });
  if (result.stdout !== "slot-reset-complete\n") throw Error("Broker reset child returned no verified acknowledgement");
};
