import { spawn } from "node:child_process";

import { DAIMON_CONTROL_PORT } from "./config.js";

/**
 * Client for a running Daimon organization's control API (port 19700), reached
 * the way every other Spawnfile probe reaches a container's loopback: an
 * ephemeral curl helper from the same image inside the target's network
 * namespace. The bearer token and any JSON body reach curl as a config on
 * stdin (`--config -`), never on a command line another host process could read.
 * Shared by `spawnfile release` (drain/resume) and production-booted training
 * trials (wakes and receipts).
 */
export interface DaimonControlTarget {
  containerRef: string;
  dockerArgs: readonly string[];
  dockerCommand: string;
  imageRef: string;
  token: string;
}

export interface DaimonControlResponse {
  body: string;
  status: number;
}

export type DaimonControlMethod = "GET" | "POST";

export type DaimonControlCall = (
  target: DaimonControlTarget,
  method: DaimonControlMethod,
  route: string,
  body?: unknown
) => Promise<DaimonControlResponse>;

/** A control call that could not produce an HTTP answer. Its message never carries the token. */
export class DaimonControlError extends Error {}

export const DAIMON_CONTROL_CALL_TIMEOUT_MS = 60_000;
const MAX_CONTROL_OUTPUT_BYTES = 1024 * 1024;

/**
 * The helper's script: the first stdin line is the bearer header, kept in a private temp file for curl's `-H @file`;
 * the rest of stdin is the request body, streamed as it is. The body used to ride a `data-binary` line of a curl
 * config, and Debian bookworm's curl (7.88) refuses a config line of 100 KiB or more ("option --config: error
 * encountered when reading a file", exit 26), so a judge wake with a large reflection prompt could never be posted.
 */
const CONTROL_HELPER_SCRIPT = [
  "set -eu", "umask 077", 'h=$(mktemp)', "trap 'rm -f \"$h\"' EXIT", "IFS= read -r line", 'printf \'%s\\n\' "$line" > "$h"',
  'if [ "$3" = body ]; then set -- "$1" "$2" -H "Content-Type: application/json" --data-binary @-; else set -- "$1" "$2"; fi',
  'method=$1; url=$2; shift 2',
  'curl -sS --max-time 15 -X "$method" -H @"$h" "$@" --output - --write-out "\\n%{http_code}" "$url"'
].join("; ");

export const daimonControlHelperArgs = (target: DaimonControlTarget, method: DaimonControlMethod, route: string, withBody = false): string[] => [
  ...target.dockerArgs,
  "run", "--rm", "-i", "--pull", "never",
  "--network", `container:${target.containerRef}`,
  "--entrypoint", "sh",
  target.imageRef,
  "-c", CONTROL_HELPER_SCRIPT, "sh", method, `http://127.0.0.1:${DAIMON_CONTROL_PORT}${route}`, withBody ? "body" : "none"
];

/** The helper's stdin: the bearer header line, then the JSON body when one is sent. */
export const daimonControlHelperInput = (token: string, body?: unknown): string =>
  `Authorization: Bearer ${token}\n${body === undefined ? "" : JSON.stringify(body)}`;

const redact = (text: string, token: string): string =>
  (token ? text.split(token).join("[redacted]") : text).replace(/\s+/gu, " ").slice(0, 240);

export const parseDaimonControlHelperOutput = (stdout: string): DaimonControlResponse => {
  const match = /\n(\d{3})$/u.exec(stdout);
  if (!match || match.index === undefined) {
    throw new DaimonControlError("the runtime control helper returned no HTTP status");
  }
  return { body: stdout.slice(0, match.index), status: Number(match[1]) };
};

export const daimonHelperControlCall: DaimonControlCall = (target, method, route, body) =>
  new Promise<DaimonControlResponse>((resolve, reject) => {
    const child = spawn(target.dockerCommand, daimonControlHelperArgs(target, method, route, body !== undefined), {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const out: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, value?: DaimonControlResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new DaimonControlError(`runtime control ${method} ${route} timed out`));
    }, DAIMON_CONTROL_CALL_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_CONTROL_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new DaimonControlError(`runtime control ${method} ${route} answered more than the output bound`));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2000); });
    child.once("error", (error) => finish(new DaimonControlError(`cannot start the runtime control helper: ${error.message}`)));
    child.once("close", (code) => {
      if (code !== 0) {
        finish(new DaimonControlError(`runtime control ${method} ${route} failed (exit ${code ?? "signal"}): ${redact(stderr, target.token)}`));
        return;
      }
      try { finish(null, parseDaimonControlHelperOutput(Buffer.concat(out).toString("utf8"))); } catch (error) { finish(error as Error); }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(daimonControlHelperInput(target.token, body));
  });
