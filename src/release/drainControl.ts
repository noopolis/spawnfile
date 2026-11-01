import {
  DAIMON_CONTROL_CALL_TIMEOUT_MS,
  DaimonControlError,
  daimonControlHelperArgs,
  daimonHelperControlCall,
  parseDaimonControlHelperOutput,
  type DaimonControlResponse,
  type DaimonControlTarget
} from "../runtime/daimon/control.js";

import { ReleaseError } from "./types.js";

/** The running organization's control plane, through the shared Daimon control client. */
export type RuntimeControlTarget = DaimonControlTarget;
export type ControlResponse = DaimonControlResponse;

export type ControlCall = (
  target: RuntimeControlTarget,
  method: "GET" | "POST",
  route: string
) => Promise<ControlResponse>;

export const CONTROL_CALL_TIMEOUT_MS = DAIMON_CONTROL_CALL_TIMEOUT_MS;
export const controlHelperArgs = daimonControlHelperArgs;

const asRelease = (error: unknown): never => {
  throw error instanceof DaimonControlError ? new ReleaseError("drain-failed", error.message) : error;
};

export const parseHelperOutput = (stdout: string): ControlResponse => {
  try { return parseDaimonControlHelperOutput(stdout); } catch (error) { return asRelease(error); }
};

export const helperControlCall: ControlCall = (target, method, route) =>
  daimonHelperControlCall(target, method, route).catch(asRelease);

export type DrainState = "draining" | "drained" | null;

export interface Availability {
  drain: DrainState;
  state: string;
}

/** The parts of `noopolis.daimon.work-availability.v1` a release reads. */
export const parseAvailability = (response: ControlResponse, route: string): Availability => {
  if (response.status === 404) {
    throw new ReleaseError("drain-failed", `the running runtime has no ${route} control route; it predates reversible drain, so it cannot be released without killing turns`);
  }
  if (response.status === 401) {
    throw new ReleaseError("drain-failed", `the runtime refused the control token on ${route}; SPAWNFILE_DAIMON_CONTROL_TOKEN in the env file must be the running deployment's token`);
  }
  if (response.status !== 200) {
    throw new ReleaseError("drain-failed", `runtime control ${route} answered HTTP ${response.status}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(response.body); } catch {
    throw new ReleaseError("drain-failed", `runtime control ${route} answered invalid JSON`);
  }
  const document = parsed as { drain?: { state?: unknown }; state?: unknown; version?: unknown } | null;
  if (document?.version !== "noopolis.daimon.work-availability.v1" || typeof document.state !== "string") {
    throw new ReleaseError("drain-failed", `runtime control ${route} answered something other than a work-availability document`);
  }
  const drain = document.drain === undefined ? null : document.drain.state;
  if (drain !== null && drain !== "draining" && drain !== "drained") {
    throw new ReleaseError("drain-failed", `runtime control ${route} reported an unknown drain state`);
  }
  return { drain, state: document.state };
};

export const requestDrain = async (target: RuntimeControlTarget, call: ControlCall = helperControlCall): Promise<Availability> => {
  const availability = parseAvailability(await call(target, "POST", "/v2/drain"), "/v2/drain");
  if (availability.drain === null) {
    throw new ReleaseError("drain-failed", "the runtime accepted /v2/drain but does not report a drain; refusing to deploy over turns it may still admit");
  }
  return availability;
};

export const requestResume = async (target: RuntimeControlTarget, call: ControlCall = helperControlCall): Promise<Availability> => {
  const availability = parseAvailability(await call(target, "POST", "/v2/resume"), "/v2/resume");
  if (availability.drain !== null) {
    throw new ReleaseError("resume-failed", "the runtime answered /v2/resume but still reports a drain");
  }
  return availability;
};

export interface WaitForDrainedOptions {
  call?: ControlCall;
  now?: () => number;
  pollMs: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs: number;
}

export type DrainWait = { drained: true; waitedMs: number } | { drained: false; reason: "interrupted" | "timeout"; waitedMs: number };

/**
 * Polls until no turn is running or admitted ("drained"), or the bound runs
 * out. Running turns are never touched: on timeout the caller abandons the
 * release and resumes; nothing here can stop a turn.
 */
export const waitForDrained = async (target: RuntimeControlTarget, options: WaitForDrainedOptions): Promise<DrainWait> => {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  for (;;) {
    if (options.signal?.aborted) return { drained: false, reason: "interrupted", waitedMs: now() - started };
    const availability = parseAvailability(await (options.call ?? helperControlCall)(target, "GET", "/v2/availability"), "/v2/availability");
    if (availability.drain === null) {
      throw new ReleaseError("drain-failed", "the runtime stopped reporting the drain while a release was waiting on it (did it restart?)");
    }
    if (availability.drain === "drained") return { drained: true, waitedMs: now() - started };
    const remaining = options.timeoutMs - (now() - started);
    if (remaining <= 0) return { drained: false, reason: "timeout", waitedMs: now() - started };
    await sleep(Math.min(options.pollMs, remaining));
  }
};
