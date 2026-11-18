import {
  DAIMON_CONTROL_CALL_TIMEOUT_MS,
  DaimonControlError,
  daimonControlHelperArgs,
  daimonHelperControlCall,
  parseDaimonControlHelperOutput,
  type DaimonControlResponse,
  type DaimonControlTarget
} from "./control.js";

import {
  createRuntimeDrainTarget, resolveRuntimeControlToken, waitForRuntimeDrain,
  type DrainWait, type WaitForDrainedOptions
} from "../../release/drainSupport.js";
import type { ReleaseRequest } from "../../release/releaseTypes.js";
import { ReleaseError } from "../../release/types.js";
import type { RuntimeDrainOperations } from "../operations.js";

export const DAIMON_CONTROL_TOKEN_ENV = "SPAWNFILE_DAIMON_CONTROL_TOKEN";

export const resolveControlToken = (request: ReleaseRequest): string | null =>
  resolveRuntimeControlToken(request, DAIMON_CONTROL_TOKEN_ENV);

export const controlTargetFor = (request: ReleaseRequest, containerRef: string, imageRef: string): RuntimeControlTarget =>
  createRuntimeDrainTarget(request, containerRef, imageRef, DAIMON_CONTROL_TOKEN_ENV, "daimon");


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

export const waitForDrained = (
  target: RuntimeControlTarget, options: WaitForDrainedOptions & { call?: ControlCall }
): Promise<DrainWait> => waitForRuntimeDrain(async () =>
  parseAvailability(await (options.call ?? helperControlCall)(target, "GET", "/v2/availability"), "/v2/availability"),
options);

export const daimonDrain: RuntimeDrainOperations = {
  controlTokenEnv: DAIMON_CONTROL_TOKEN_ENV,
  drain: requestDrain,
  resume: requestResume,
  async availability(target) {
    return parseAvailability(await helperControlCall(target, "GET", "/v2/availability"), "/v2/availability");
  }
};
