import { resolveDockerBaseArgs } from "../distribution/extractImage.js";
import type { RuntimeAvailability, RuntimeDrainTarget } from "../runtime/operations.js";

import type { ReleaseRequest } from "./releaseTypes.js";
import { ReleaseError } from "./types.js";

export interface WaitForDrainedOptions {
  now?: () => number;
  pollMs: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs: number;
}

export type DrainWait = { drained: true; waitedMs: number } |
  { drained: false; reason: "interrupted" | "timeout"; waitedMs: number };

/** Same precedence up applies: a process value overrides the env file. */
export const resolveRuntimeControlToken = (request: ReleaseRequest, envName: string): string | null => {
  const fromProcess = process.env[envName];
  if (typeof fromProcess === "string" && fromProcess.length > 0) return fromProcess;
  const fromFile = request.envFileEnv[envName];
  return typeof fromFile === "string" && fromFile.length > 0 ? fromFile : null;
};

export const createRuntimeDrainTarget = (
  request: ReleaseRequest, containerRef: string, imageRef: string, controlTokenEnv?: string, runtime?: string
): RuntimeDrainTarget => {
  const token = controlTokenEnv === undefined ? "" : resolveRuntimeControlToken(request, controlTokenEnv);
  if (token === null) {
    throw new ReleaseError("blocked", `${controlTokenEnv} is not set in the env file or environment; a drained release needs the running deployment's control token`);
  }
  return {
    containerRef,
    dockerArgs: resolveDockerBaseArgs({ ...(request.dockerContext ? { dockerContext: request.dockerContext } : {}), ...(request.dockerHost ? { dockerHost: request.dockerHost } : {}) }),
    dockerCommand: request.dockerCommand,
    imageRef,
    token,
    ...(runtime ? { runtime } : {})
  };
};

/** Waits for runtime admission to report drained, with an operator-supplied bound. */
export const waitForRuntimeDrain = async (
  availability: () => Promise<RuntimeAvailability>, options: WaitForDrainedOptions
): Promise<DrainWait> => {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  for (;;) {
    if (options.signal?.aborted) return { drained: false, reason: "interrupted", waitedMs: now() - started };
    const { drain } = await availability();
    if (drain === null) {
      throw new ReleaseError("drain-failed", "the runtime stopped reporting the drain while a release was waiting on it (did it restart?)");
    }
    const waitedMs = now() - started;
    if (drain === "drained") return { drained: true, waitedMs };
    if (waitedMs >= options.timeoutMs) return { drained: false, reason: "timeout", waitedMs };
    await sleep(Math.min(options.pollMs, options.timeoutMs - waitedMs));
  }
};
