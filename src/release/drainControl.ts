import { spawn } from "node:child_process";

import { DAIMON_CONTROL_PORT } from "../runtime/daimon/config.js";

import { ReleaseError } from "./types.js";

/**
 * The running organization's control plane, reached the way every other
 * Spawnfile probe reaches a container's loopback: an ephemeral helper from the
 * same image inside the target's network namespace. The bearer token goes to
 * curl on stdin (`-H @-`), never on a command line another host process could
 * read.
 */
export interface RuntimeControlTarget {
  containerRef: string;
  dockerArgs: readonly string[];
  dockerCommand: string;
  imageRef: string;
  token: string;
}

export interface ControlResponse {
  body: string;
  status: number;
}

export type ControlCall = (
  target: RuntimeControlTarget,
  method: "GET" | "POST",
  route: string
) => Promise<ControlResponse>;

export const CONTROL_CALL_TIMEOUT_MS = 60_000;
const MAX_CONTROL_OUTPUT_BYTES = 1024 * 1024;

export const controlHelperArgs = (target: RuntimeControlTarget, method: "GET" | "POST", route: string): string[] => [
  ...target.dockerArgs,
  "run", "--rm", "-i", "--pull", "never",
  "--network", `container:${target.containerRef}`,
  "--entrypoint", "curl",
  target.imageRef,
  "-sS", "--max-time", "15", "-X", method, "-H", "@-",
  "--output", "-", "--write-out", "\\n%{http_code}",
  `http://127.0.0.1:${DAIMON_CONTROL_PORT}${route}`
];

const redact = (text: string, token: string): string =>
  (token ? text.split(token).join("[redacted]") : text).replace(/\s+/gu, " ").slice(0, 240);

export const parseHelperOutput = (stdout: string): ControlResponse => {
  const match = /\n(\d{3})$/u.exec(stdout);
  if (!match || match.index === undefined) {
    throw new ReleaseError("drain-failed", "the runtime control helper returned no HTTP status");
  }
  return { body: stdout.slice(0, match.index), status: Number(match[1]) };
};

export const helperControlCall: ControlCall = (target, method, route) =>
  new Promise<ControlResponse>((resolve, reject) => {
    const child = spawn(target.dockerCommand, controlHelperArgs(target, method, route), {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const out: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, value?: ControlResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new ReleaseError("drain-failed", `runtime control ${method} ${route} timed out`));
    }, CONTROL_CALL_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_CONTROL_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new ReleaseError("drain-failed", `runtime control ${method} ${route} answered more than the output bound`));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2000); });
    child.once("error", (error) => finish(new ReleaseError("drain-failed", `cannot start the runtime control helper: ${error.message}`)));
    child.once("close", (code) => {
      if (code !== 0) {
        finish(new ReleaseError("drain-failed", `runtime control ${method} ${route} failed (exit ${code ?? "signal"}): ${redact(stderr, target.token)}`));
        return;
      }
      try { finish(null, parseHelperOutput(Buffer.concat(out).toString("utf8"))); } catch (error) { finish(error as Error); }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(`Authorization: Bearer ${target.token}\n`);
  });

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
