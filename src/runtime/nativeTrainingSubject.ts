import { randomUUID } from "node:crypto";
import path from "node:path";

import type { StopReceipt, SubjectAdapter, SubjectOutput, SubjectStart } from "./trainingTypes.js";
import type { NativeTrainingDriver, NativeTrainingInstance } from "./nativeTraining.js";

export interface NativeTrainingTrial {
  instance: NativeTrainingInstance;
  readOutput(file: string): Promise<string | null>;
  syncInputs(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export function createNativeTrainingSubject(
  runtime: string, driver: NativeTrainingDriver, timeoutMs: number,
  boot: (input: SubjectStart) => Promise<NativeTrainingTrial>
): SubjectAdapter {
  return {
    id: runtime,
    capabilities: {
      toolTrace: "partial", liveObservations: false, cancellation: "native-handle", multiTurn: true,
      resources: ["instructions"], isolation: "one compiled container per trial", readIsolation: "declared-paths",
      protectedPaths: true, trialIsolation: "per-start", stopAcknowledgementMs: 120_000
    },
    async start(input) {
      const trial = await boot(input);
      const sessionId = randomUUID();
      let sequence = 0;
      let stopped: Promise<StopReceipt> | undefined;
      let reply: string | undefined;
      let last: Record<string, SubjectOutput> = {};
      return {
        async run(turn, signal = input.signal) {
          if (stopped) throw new Error("The training trial has already stopped");
          signal?.throwIfAborted();
          await trial.syncInputs(signal);
          const native = await driver.run(trial.instance, { trialId: input.trialId, wakeId: turn.id, sessionId, text: turn.text, timeoutMs, signal });
          if (native.toolCoverage.channel !== "tools") throw new Error("The native driver must declare its tool coverage");
          for (const event of native.observations ?? []) {
            if (event.trialId !== input.trialId || event.wakeId !== turn.id) throw new Error("Native evidence belongs to another trial or turn");
            await input.onObservation(event);
          }
          reply = native.text;
          const source = `training-reply:${sessionId}`;
          await input.onObservation({ id: `${source}:${++sequence}`, source, seq: sequence, trialId: input.trialId,
            wakeId: turn.id, timestamp: new Date().toISOString(), type: "output", text: reply });
          return {
            status: "completed", text: reply, usage: native.usage ?? null, evidence: { adapterId: runtime, payload: { sessionId } },
            coverage: [native.toolCoverage, { channel: "output", completeness: "complete", ordering: "none" },
              { channel: "usage", completeness: native.usage ? "partial" : "absent", ordering: "none" }]
          };
        },
        async collect(outputs) {
          if (stopped) return { ...last };
          const collected: Record<string, SubjectOutput> = {};
          for (const [name, file] of Object.entries(outputs)) {
            if (path.posix.isAbsolute(file) || file.split(/[\\/]/u).some(part => !part || part === ".." || part === ".")) {
              throw new Error("Training output must be a workspace-relative file");
            }
            const bytes = await trial.readOutput(file);
            if (bytes !== null) collected[name] = { bytes, provenance: `trial-workspace:${file}` };
          }
          if (reply !== undefined && !Object.hasOwn(collected, "reply")) collected.reply = { bytes: reply, provenance: "trial-reply" };
          last = collected;
          return { ...last };
        },
        stop(reason) {
          return stopped ??= trial.close().then((): StopReceipt => ({
            state: "acknowledged", quiescence: "confirmed", scope: "native-handle", remoteWork: "unknown", reason, detail: "Trial container removed"
          }), (error: unknown): StopReceipt => ({
            state: "unknown", quiescence: "unknown", scope: "native-handle", remoteWork: "unknown", reason,
            detail: error instanceof Error ? error.message : "Trial cleanup failed"
          }));
        }
      };
    }
  };
}
