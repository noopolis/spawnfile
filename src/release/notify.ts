import { spawn } from "node:child_process";
import { hostname } from "node:os";
import path from "node:path";

import type { ReleaseFailureReason } from "./types.js";

export const RELEASE_NOTIFICATION_VERSION = "spawnfile.release-notification.v1" as const;

export type NotifierConfig =
  | { kind: "command"; command: string }
  | { kind: "none" }
  | { kind: "webhook"; urlEnv: string };

export interface ReleaseNotification {
  at: string;
  deployment: string;
  host: string;
  identity: string | null;
  message: string;
  reason: ReleaseFailureReason;
  version: typeof RELEASE_NOTIFICATION_VERSION;
}

export interface NotifyResult {
  channel: NotifierConfig["kind"];
  delivered: boolean;
  error?: string;
}

const MAX_MESSAGE_CHARS = 500;
const PATHLIKE = /(?:\/[A-Za-z0-9._@-]+){2,}\/?/gu;

/**
 * A notification says what broke, not where the box keeps things: anything
 * path-shaped becomes `<path>` and the text is capped. The full detail stays
 * in the release log on the host.
 */
export const shortReason = (message: string): string => {
  const scrubbed = message.replace(PATHLIKE, "<path>").replace(/\s+/gu, " ").trim();
  return scrubbed.length > MAX_MESSAGE_CHARS ? `${scrubbed.slice(0, MAX_MESSAGE_CHARS - 1)}…` : scrubbed;
};

export const createNotification = (input: {
  deployment: string;
  identity: string | null;
  message: string;
  now?: Date;
  reason: ReleaseFailureReason;
}): ReleaseNotification => ({
  at: (input.now ?? new Date()).toISOString(),
  deployment: input.deployment,
  host: hostname(),
  identity: input.identity,
  message: shortReason(input.message),
  reason: input.reason,
  version: RELEASE_NOTIFICATION_VERSION
});

/** Parses CLI declarations; at most one channel. */
export const resolveNotifierConfig = (options: { notifyCommand?: string; notifyWebhookEnv?: string }): NotifierConfig => {
  if (options.notifyCommand !== undefined && options.notifyWebhookEnv !== undefined) {
    throw new Error("declare one notifier: --notify-command or --notify-webhook-env, not both");
  }
  if (options.notifyCommand !== undefined) {
    if (!path.isAbsolute(options.notifyCommand)) throw new Error("--notify-command must be an absolute path to an executable");
    return { command: options.notifyCommand, kind: "command" };
  }
  if (options.notifyWebhookEnv !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(options.notifyWebhookEnv)) throw new Error("--notify-webhook-env must name an environment variable");
    return { kind: "webhook", urlEnv: options.notifyWebhookEnv };
  }
  return { kind: "none" };
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const resolveWebhookUrl = (env: NodeJS.ProcessEnv, name: string): URL => {
  const raw = env[name];
  if (!raw) throw new Error(`${name} is not set, so the webhook notifier has no URL`);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${name} is not a URL`); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Error(`${name} must be an https URL (plain http only for loopback)`);
  }
  return url;
};

export interface NotifyDependencies {
  attempts?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  runCommand?: (command: string, input: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<number | null>;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

const runNotifierCommand = (command: string, input: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<number | null> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [], { env, stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code); });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });

const notifyCommand = async (command: string, notification: ReleaseNotification, deps: NotifyDependencies): Promise<NotifyResult> => {
  const env = {
    ...(deps.env ?? process.env),
    SPAWNFILE_RELEASE_DEPLOYMENT: notification.deployment,
    SPAWNFILE_RELEASE_IDENTITY: notification.identity ?? "",
    SPAWNFILE_RELEASE_MESSAGE: notification.message,
    SPAWNFILE_RELEASE_REASON: notification.reason
  };
  try {
    const code = await (deps.runCommand ?? runNotifierCommand)(command, `${JSON.stringify(notification)}\n`, env, deps.timeoutMs ?? 60_000);
    return code === 0 ? { channel: "command", delivered: true } : { channel: "command", delivered: false, error: `notifier exited ${code ?? "by signal"}` };
  } catch (error) {
    return { channel: "command", delivered: false, error: `notifier could not run: ${(error as Error).message}` };
  }
};

const notifyWebhook = async (urlEnv: string, notification: ReleaseNotification, deps: NotifyDependencies): Promise<NotifyResult> => {
  let url: URL;
  try { url = resolveWebhookUrl(deps.env ?? process.env, urlEnv); } catch (error) {
    return { channel: "webhook", delivered: false, error: (error as Error).message };
  }
  const attempts = deps.attempts ?? 3;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const errors: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await (deps.fetchImpl ?? fetch)(url, {
        body: JSON.stringify(notification),
        headers: { "content-type": "application/json" },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000)
      });
      if (response.ok) return { channel: "webhook", delivered: true };
      errors.push(`HTTP ${response.status}`);
    } catch (error) {
      errors.push((error as Error).name === "TimeoutError" ? "timed out" : "request failed");
    }
    if (attempt < attempts) await sleep(attempt * 2_000);
  }
  return { channel: "webhook", delivered: false, error: errors.join("; ") };
};

/**
 * Never throws: a notifier that crashed the release reporting the failure
 * would be worse than none. The caller records the result in the release log,
 * so an undelivered notification still leaves its text on disk.
 */
export const sendNotification = async (
  config: NotifierConfig,
  notification: ReleaseNotification,
  deps: NotifyDependencies = {}
): Promise<NotifyResult> => {
  if (config.kind === "command") return notifyCommand(config.command, notification, deps);
  if (config.kind === "webhook") return notifyWebhook(config.urlEnv, notification, deps);
  return { channel: "none", delivered: false, error: "no notifier declared" };
};
