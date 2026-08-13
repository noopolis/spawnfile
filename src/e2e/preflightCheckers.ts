import { spawn } from "node:child_process";
import path from "node:path";
import { fileExists, readUtf8File } from "../filesystem/index.js";
import {
  CHECK_IDS,
  type B18PreflightCheck,
  type JsonObject,
  type PreflightCommandResult,
  type PreflightCommandRunner
} from "./preflightTypes.js";

export type CheckStatus = "passed" | "skipped" | "unavailable";

export const PASS: CheckStatus = "passed";
export const SKIP: CheckStatus = "skipped";
export const FAIL: CheckStatus = "unavailable";

export const parseJson = <T>(source: string): T | undefined => {
  try {
    return JSON.parse(source) as T;
  } catch {
    return undefined;
  }
};

export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export const createCheck = (
  status: CheckStatus,
  id: string,
  name: string,
  reason: string
): B18PreflightCheck => ({
  id,
  name,
  reason,
  status
});

export const parseDockerContextList = (stdout: string): string[] =>
  stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/u)[0])
    .filter((entry) => entry.length > 0);

export const createDefaultCommandRunner = (timeoutMs: number): PreflightCommandRunner => async (
  command,
  args,
  overrideTimeoutMs
): Promise<PreflightCommandResult> => {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let exited = false;
    let child: ReturnType<typeof spawn> | null = null;

    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({
        exitCode: 127,
        stderr: error instanceof Error ? error.message : String(error),
        stdout,
        timedOut: false
      });
      return;
    }

    const activeTimeoutMs = Number.isFinite(overrideTimeoutMs) ? overrideTimeoutMs : timeoutMs;
    const timer = setTimeout(() => {
      if (exited) return;
      exited = true;
      child?.kill("SIGKILL");
      resolve({
        exitCode: 124,
        stderr: `command timed out after ${activeTimeoutMs}ms`,
        stdout,
        timedOut: true
      });
    }, activeTimeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const finish = (code: number, timedOut = false): void => {
      if (exited) return;
      exited = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stderr,
        stdout,
        timedOut
      });
    };

    child.once("error", () => {
      finish(127, false);
    });

    child.once("close", (code) => {
      finish(code ?? 1, false);
    });
  });
};

export const checkCommand = async (
  commandRunner: PreflightCommandRunner,
  command: string,
  args: string[],
  timeoutMs: number,
  id: string,
  name: string
): Promise<B18PreflightCheck> => {
  const result = await commandRunner(command, args, timeoutMs);
  if (result.timedOut) {
    return createCheck(FAIL, id, name, `${name} check timed out after ${timeoutMs}ms`);
  }
  if (result.exitCode !== 0) {
    return createCheck(
      FAIL,
      id,
      name,
      `${name} check failed with exit code ${result.exitCode}` +
        (result.stderr.trim() ? ` (${result.stderr.trim()})` : "")
    );
  }
  return createCheck(PASS, id, name, `${name} check passed`);
};

export const checkClaudeAuth = async (credentialsPath: string): Promise<B18PreflightCheck> => {
  if (!(await fileExists(credentialsPath))) {
    return createCheck(
      FAIL,
      CHECK_IDS.claude,
      "Claude auth",
      `Claude Code credentials file is missing at ${credentialsPath}`
    );
  }
  const parsed = parseJson<JsonObject>(await readUtf8File(credentialsPath));
  if (!parsed) {
    return createCheck(
      FAIL,
      CHECK_IDS.claude,
      "Claude auth",
      `Claude Code credentials file exists at ${credentialsPath} but has invalid JSON`
    );
  }
  const oauth = parsed.claudeAiOauth;
  const accessToken = oauth && typeof oauth === "object"
    ? (oauth as JsonObject).accessToken
    : undefined;
  const expiresAt = oauth && typeof oauth === "object"
    ? (oauth as JsonObject).expiresAt
    : undefined;
  if (!isNonEmptyString(accessToken) || typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    return createCheck(
      FAIL,
      CHECK_IDS.claude,
      "Claude auth",
      `Claude Code credentials file exists at ${credentialsPath} but is missing OAuth credential fields`
    );
  }
  return createCheck(
    PASS,
    CHECK_IDS.claude,
    "Claude auth",
    `Claude Code credentials are present at ${credentialsPath}`
  );
};

export const checkCodexAuth = async (codexAuthPath: string): Promise<B18PreflightCheck> => {
  const name = "Codex auth";
  if (!(await fileExists(codexAuthPath))) {
    return createCheck(FAIL, CHECK_IDS.codex, name, `Codex auth file is missing at ${codexAuthPath}`);
  }
  const parsed = parseJson<JsonObject>(await readUtf8File(codexAuthPath));
  if (!parsed) {
    return createCheck(FAIL, CHECK_IDS.codex, name, "Codex auth file is not valid JSON");
  }
  const tokens = parsed.tokens;
  if (!tokens || typeof tokens !== "object") {
    return createCheck(FAIL, CHECK_IDS.codex, name, "Codex auth file is missing a tokens section");
  }
  const codexTokens = tokens as JsonObject;
  if (!isNonEmptyString(codexTokens.access_token) || !isNonEmptyString(codexTokens.refresh_token)) {
    return createCheck(FAIL, CHECK_IDS.codex, name, "Codex auth file is missing required token fields");
  }
  return createCheck(PASS, CHECK_IDS.codex, name, "Codex auth file has required token fields");
};

export const checkDockerContextList = async (
  commandRunner: PreflightCommandRunner,
  dockerCommand: string,
  timeoutMs: number
): Promise<{ check: B18PreflightCheck; contexts: string[] }> => {
  const contextResult = await commandRunner(
    dockerCommand,
    ["context", "ls", "--format", "{{.Name}} {{.Current}}"],
    timeoutMs
  );
  if (contextResult.timedOut) {
    return {
      check: createCheck(FAIL, CHECK_IDS.dockerContextList, "Docker context list", "Docker context check timed out"),
      contexts: []
    };
  }

  if (contextResult.exitCode !== 0) {
    return {
      check: createCheck(
        FAIL,
        CHECK_IDS.dockerContextList,
        "Docker context list",
        contextResult.stderr.trim().length > 0
          ? `Docker context command failed: ${contextResult.stderr.trim()}`
          : "Docker context command failed"
      ),
      contexts: []
    };
  }

  const contexts = parseDockerContextList(contextResult.stdout);
  if (contexts.length === 0) {
    return {
      check: createCheck(FAIL, CHECK_IDS.dockerContextList, "Docker context list", "No Docker contexts were returned"),
      contexts: []
    };
  }

  return {
    check: createCheck(
      PASS,
      CHECK_IDS.dockerContextList,
      "Docker context list",
      `Docker context list is available with ${contexts.length} entry(ies)`
    ),
    contexts
  };
};

export const checkDockerRemoteContext = async (
  commandRunner: PreflightCommandRunner,
  dockerCommand: string,
  remoteContext: string,
  contexts: string[],
  id: string,
  timeoutMs: number
): Promise<B18PreflightCheck> => {
  const hasRemote = contexts.some(
    (entry) => entry === remoteContext || entry.includes(remoteContext)
  );
  if (!hasRemote) {
    return createCheck(
      SKIP,
      id,
      `Docker context ${remoteContext}`,
      `Remote docker context ${remoteContext} was not found`
    );
  }
  const result = await commandRunner(dockerCommand, ["--context", remoteContext, "info"], timeoutMs);
  if (result.timedOut) {
    return createCheck(
      FAIL,
      id,
      `Docker context ${remoteContext}`,
      `Docker context ${remoteContext} info timed out after ${timeoutMs}ms`
    );
  }
  if (result.exitCode !== 0) {
    return createCheck(
      FAIL,
      id,
      `Docker context ${remoteContext}`,
      `Docker context ${remoteContext} info failed with exit code ${result.exitCode}` +
        (result.stderr.trim() ? ` (${result.stderr.trim()})` : "")
    );
  }
  return createCheck(
    PASS,
    id,
    `Docker context ${remoteContext}`,
    `Docker context ${remoteContext} is reachable`
  );
};


export const checkRuntimeAssets = async (
  root: string,
  runtime: "openclaw" | "picoclaw"
): Promise<B18PreflightCheck> => {
  const dockerfile = path.join(root, "runtime-images", runtime, "Dockerfile");
  const manifest = runtime === "openclaw"
    ? path.join(root, "blueprints", "openclaw", "openclaw.json")
    : path.join(root, "blueprints", "picoclaw", "config.json");

  const missing: string[] = [];
  if (!(await fileExists(dockerfile))) {
    missing.push(`${runtime} Dockerfile`);
  }
  if (!(await fileExists(manifest))) {
    missing.push(`${runtime} runtime assets manifest`);
  }

  if (missing.length > 0) {
    return createCheck(
      FAIL,
      runtime === "openclaw" ? CHECK_IDS.openclawAssets : CHECK_IDS.picoclawAssets,
      `${runtime} assets`,
      `${runtime} runtime assets missing: ${missing.join(", ")}`
    );
  }

  return createCheck(
    PASS,
    runtime === "openclaw" ? CHECK_IDS.openclawAssets : CHECK_IDS.picoclawAssets,
    `${runtime} assets`,
    `${runtime} runtime assets are present`
  );
};
