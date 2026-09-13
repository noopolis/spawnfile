import { randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveSpawnfileHome } from "../auth/index.js";
import type { DockerCommandRunner } from "../distribution/dockerRunner.js";
import { redactDockerLogText } from "./dockerLogs.js";
import { resolveHomeDeploymentDirectory } from "./homeStore.js";

const outputLimit = 64 * 1024;
const commandOptions = { captureStderr: true, maxOutputBytes: outputLimit, timeoutMs: 5_000 };
const containerIdPattern = /^[a-f0-9]{64}$/u;

export interface CandidateDiagnosticsInput {
  candidateId: string;
  deploymentName: string;
  runDocker: DockerCommandRunner;
  secretValues: string[];
}

export interface CandidateDiagnosticsResult {
  path: string | null;
  summary: string;
}

/** Redaction is best effort; diagnostic artifacts remain private operator data. */
export const sanitizeCandidateDiagnostic = (text: string, secrets: string[]): string =>
  redactDockerLogText(text, secrets)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu, "[REDACTED PRIVATE KEY]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED JWT]")
    .replace(/https?:\/\/[^\s<>"']+/giu, "[REDACTED URL]")
    .replace(/\b([a-z0-9_-]*(?:authorization|cookie|password|secret|token|api[_-]?key)[a-z0-9_-]*)["']?\s*[:=]\s*[^\r\n]+/giu, "$1: [REDACTED]")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f]/gu, "");

const collect = async (runDocker: DockerCommandRunner, args: string[]) => {
  try {
    const bytes = await runDocker(args, commandOptions);
    // Injectable runners must obey the same limit as the default Docker runner.
    if (bytes.length > outputLimit) throw new Error("limit");
    return { available: true, text: bytes.toString("utf8") };
  } catch {
    // Docker transport errors can contain command/env details; never persist them.
    return { available: false, text: "Diagnostic command failed, timed out, or exceeded its byte limit" };
  }
};

const summarizeState = (raw: string, secrets: string[]) => {
  try {
    const state = JSON.parse(raw) as Record<string, unknown>;
    const health = (state.Health as { Status?: unknown } | undefined)?.Status;
    const status = ["created", "running", "paused", "restarting", "removing", "exited", "dead"].includes(String(state.Status))
      ? state.Status : "unknown";
    const parts = [`state=${status}`];
    if (["starting", "healthy", "unhealthy"].includes(String(health))) parts.push(`health=${health}`);
    if (Number.isSafeInteger(state.ExitCode)) parts.push(`exit=${state.ExitCode}`);
    if (state.OOMKilled === true) parts.push("oom-killed");
    const healthState = state.Health as { Log?: unknown } | undefined;
    const text = (value: unknown) => typeof value === "string"
      ? sanitizeCandidateDiagnostic(value, secrets).slice(0, 4_096) : "";
    return { available: true, summary: parts.join(", "), error: text(state.Error),
      healthOutput: Array.isArray(healthState?.Log) ? healthState.Log.slice(-3).map((entry: unknown) =>
        text(entry && typeof entry === "object" ? (entry as { Output?: unknown }).Output : null)) : [] };
  } catch { return { available: false, summary: "state unavailable", error: "", healthOutput: [] }; }
};

/** Collect before rollback deletes the only container-local startup evidence. */
export const captureCandidateDiagnostics = async (
  input: CandidateDiagnosticsInput
): Promise<CandidateDiagnosticsResult> => {
  if (!containerIdPattern.test(input.candidateId)) return { path: null, summary: "invalid candidate identity" };
  const [state, logs] = await Promise.all([
    collect(input.runDocker, ["container", "inspect", "--format", "{{json .State}}", input.candidateId]),
    collect(input.runDocker, ["logs", "--tail", "100", input.candidateId])
  ]);
  const health = summarizeState(state.available ? state.text : "", input.secretValues);
  const summary = health.summary;
  try {
    const deploymentDirectory = resolveHomeDeploymentDirectory(input.deploymentName);
    for (const parent of [resolveSpawnfileHome(), path.dirname(deploymentDirectory), deploymentDirectory]) {
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0
        || (process.getuid && info.uid !== process.getuid())) throw new Error("unsafe diagnostics parent");
    }
    const directory = path.join(deploymentDirectory, "diagnostics");
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700
      || (process.getuid && info.uid !== process.getuid())) throw new Error("unsafe diagnostics directory");
    const destination = path.join(directory, `candidate-${Date.now()}-${randomUUID()}.json`);
    await writeFile(destination, `${JSON.stringify({
      version: "spawnfile.candidate-diagnostics.v1", capturedAt: new Date().toISOString(),
      candidateId: input.candidateId, deployment: input.deploymentName, summary, health,
      logs: { available: logs.available, text: sanitizeCandidateDiagnostic(logs.text, input.secretValues) }
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return { path: destination, summary };
  } catch { return { path: null, summary }; }
};
