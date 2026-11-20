import { requireLiveTraining } from "../runtime/trainingSelection.js";
import type { RunTrainingOptions } from "./trainingExecution.js";

/** Cancels a live run through the selected runtime and waits for cleanup. */
export const runBootedTraining = async (options: RunTrainingOptions): Promise<number> => {
  if (options.signal?.aborted) return 130;
  const run = await requireLiveTraining(options.context.agent.runtime, options.context.agent.id);
  if (options.signal?.aborted) return 130;
  // An interrupt cancels the run so its trials, judges and gateway are torn down and the realm is free again; without
  // this, the process died at once and left a gateway holding the login for every later run. A second interrupt exits.
  const controller = new AbortController();
  let interrupted: number | undefined;
  const onSignal = (code: number) => () => {
    if (interrupted !== undefined) process.exit(code);
    interrupted = code;
    options.streams.stderr("training interrupted: stopping trials and judges and releasing the training realm (interrupt again to exit now)");
    controller.abort();
  };
  const onInt = onSignal(130), onTerm = onSignal(143);
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const code = await run({ ...options, signal: controller.signal });
    return interrupted ?? code;
  } catch (error) {
    if (interrupted !== undefined) return interrupted;
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm);
  }
};
