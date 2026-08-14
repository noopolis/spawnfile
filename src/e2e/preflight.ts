import os from "node:os";
import path from "node:path";

import {
  CHECK_IDS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_MOLTNET_SERVER_URL,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_REMOTE_DOCKER_CONTEXT,
  type B18PreflightCheck,
  type B18PreflightOptions,
  type B18PreflightReport,
  type PreflightCommandRunner
} from "./preflightTypes.js";
import {
  checkClaudeAuth,
  checkCommand,
  checkCodexAuth,
  checkDockerContextList,
  checkDockerRemoteContext,
  checkRuntimeAssets,
  createDefaultCommandRunner,
  FAIL,
  PASS,
  SKIP
} from "./preflightCheckers.js";
import { checkAntigravityAuth, checkGrokAuth } from "./preflightCliTokenCheckers.js";
import { probeCompileEvidence } from "./preflightCompile.js";
import { checkMoltnetServer, checkOllamaEmbeddings } from "./preflightNetworkChecks.js";

export type {
  B18PreflightCheck,
  B18PreflightOptions,
  B18PreflightReport,
  PreflightCommandRunner,
  PreflightCommandResult,
  PreflightCheckStatus
} from "./preflightTypes.js";
export type E2EPreflightStatus = "ready" | "skipped" | "unavailable";

export interface E2EPreflightCheck {
  category: "auth" | "docker" | "runtime" | "service" | "tooling";
  details: string[];
  id: string;
  label: string;
  reason: string;
  status: E2EPreflightStatus;
}

export interface E2EPreflightReport {
  checks: E2EPreflightCheck[];
  generatedAt: string;
  summary: {
    overall: "attention" | "ready";
    ready: number;
    skipped: number;
    unavailable: number;
  };
  version: "spawnfile.e2e-preflight.v1";
}

export interface E2EPreflightOptions {
  antigravityCliCommand?: string;
  antigravityHome?: string;
  claudeCodeDirectory?: string;
  codexDirectory?: string;
  dockerCommand?: string;
  fixtureDirectory?: string;
  grokHome?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  timeoutMs?: number;
}

const legacyCategoryForId = (id: string): E2EPreflightCheck["category"] => {
  if (id === "codex" || id === "claude" || id.startsWith("grok") || id.startsWith("antigravity")) {
    return "auth";
  }
  if (id.startsWith("docker")) {
    return "docker";
  }
  if (id === "daimon" || id === "mneme" || id === "openclaw" || id === "picoclaw") {
    return "runtime";
  }
  if (id === "moltnet") {
    return "tooling";
  }
  if (id === "ollama-embeddings" || id === "moltnet-server") {
    return "service";
  }
  if (id === "moltnet-cli") {
    return "tooling";
  }
  if (id.startsWith("runtime-assets")) {
    return "runtime";
  }
  return "tooling";
};

const legacyStatus = (status: "passed" | "skipped" | "unavailable"): "ready" | "skipped" | "unavailable" =>
  status === "passed" ? "ready" : status;

const adaptPreflightReport = (report: B18PreflightReport): E2EPreflightReport => ({
  checks: report.checks.map((entry) => ({
    category: legacyCategoryForId(entry.id),
    details: [],
    id: entry.id,
    label: entry.name,
    reason: entry.reason,
    status: legacyStatus(entry.status)
  })),
  generatedAt: new Date().toISOString(),
  summary: {
    overall: report.readyForLive ? "ready" : "attention",
    ready: report.summary.passed,
    skipped: report.summary.skipped,
    unavailable: report.summary.unavailable
  },
  version: "spawnfile.e2e-preflight.v1"
});

export const runE2EPreflight = async (
  options: E2EPreflightOptions = {}
): Promise<E2EPreflightReport> => {
  const timeoutMs = options.timeoutMs;
  const report = await runB18Preflight({
    antigravityAuthPath: options.antigravityHome,
    antigravityCliCommand: options.antigravityCliCommand,
    claudeAuthPath: options.claudeCodeDirectory && path.join(options.claudeCodeDirectory, ".credentials.json"),
    codexAuthPath: options.codexDirectory && path.join(options.codexDirectory, "auth.json"),
    commandTimeoutMs: timeoutMs,
    dockerCommand: options.dockerCommand,
    fetchTimeoutMs: timeoutMs,
    fetcher: fetch,
    grokAuthPath: options.grokHome,
    mixedRuntimeFixtureDirectory: options.fixtureDirectory,
    ollamaBaseUrl: options.ollamaBaseUrl,
    ollamaModel: options.ollamaModel,
    projectRoot: process.cwd(),
    runtimeAssetRoot: process.cwd()
  });
  return adaptPreflightReport(report);
};

export const exitCodeForE2EPreflight = (report: E2EPreflightReport): number =>
  report.summary.unavailable > 0 ? 1 : 0;

export const renderE2EPreflightText = (report: E2EPreflightReport): string => {
  const lines = [
    `Spawnfile E2E preflight: ${report.summary.overall}`,
    `passed=${report.summary.ready} skipped=${report.summary.skipped} unavailable=${report.summary.unavailable}`,
    `generated=${report.generatedAt}`
  ];
  for (const check of report.checks) {
    const status = check.status === "ready" ? "PASS" : check.status.toUpperCase();
    lines.push(`${status} ${check.id} ${check.label}: ${check.reason}`);
  }
  return lines.join("\n");
};

const createSkippedRemoteContextCheck = (id: string, remoteContext: string): B18PreflightCheck => ({
  id,
  name: `Docker context ${remoteContext}`,
  status: SKIP,
  reason: "Skipped remote context check because context list was unavailable"
});

export const runB18Preflight = async (
  options: B18PreflightOptions = {}
): Promise<B18PreflightReport> => {
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const commandRunner = options.commandRunner ?? createDefaultCommandRunner(commandTimeoutMs);
  const fetcher = options.fetcher ?? fetch;

  const homeDirectory = options.homeDirectory ?? os.homedir();
  const projectRoot = options.projectRoot ?? process.cwd();
  const runtimeAssetRoot = options.runtimeAssetRoot ?? process.cwd();
  const mixedRuntimeFixtureDirectory =
    options.mixedRuntimeFixtureDirectory ??
    path.join(projectRoot, "examples", "mixed-runtime-org");
  const dockerCommand = options.dockerCommand ?? "docker";
  const remoteContext = options.dockerRemoteContext ?? DEFAULT_REMOTE_DOCKER_CONTEXT;
  const remoteContextId = `${CHECK_IDS.dockerRemoteContext}-${remoteContext}`;

  const checks: B18PreflightCheck[] = [];
  checks.push(await checkCodexAuth(options.codexAuthPath ?? path.join(homeDirectory, ".codex", "auth.json")));
  checks.push(await checkClaudeAuth(
    options.claudeAuthPath ?? path.join(homeDirectory, ".claude", ".credentials.json")
  ));

  checks.push(await checkCommand(
    commandRunner,
    options.grokCliCommand ?? "grok",
    ["--version"],
    commandTimeoutMs,
    CHECK_IDS.grok,
    "Grok CLI"
  ));
  checks.push(await checkGrokAuth(
    options.grokAuthPath ?? process.env.GROK_HOME ?? path.join(homeDirectory, ".grok")
  ));

  checks.push(await checkCommand(
    commandRunner,
    options.antigravityCliCommand ?? "agy",
    ["--version"],
    commandTimeoutMs,
    CHECK_IDS.antigravity,
    "Antigravity CLI"
  ));
  checks.push(await checkAntigravityAuth(
    options.antigravityAuthPath ??
      process.env.ANTIGRAVITY_CLI_HOME ??
      path.join(homeDirectory, ".gemini", "antigravity-cli")
  ));

  checks.push(await checkOllamaEmbeddings(
    fetcher,
    options.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL,
    fetchTimeoutMs,
    options.ollamaModel
  ));

  checks.push(await checkCommand(
    commandRunner,
    dockerCommand,
    ["info"],
    commandTimeoutMs,
    CHECK_IDS.dockerDaemon,
    "Docker daemon"
  ));

  const dockerContextCheck = await checkDockerContextList(commandRunner, dockerCommand, commandTimeoutMs);
  checks.push(dockerContextCheck.check);
  checks.push(
    dockerContextCheck.check.status === FAIL
      ? createSkippedRemoteContextCheck(remoteContextId, remoteContext)
      : await checkDockerRemoteContext(commandRunner, dockerCommand, remoteContext, dockerContextCheck.contexts, remoteContextId, commandTimeoutMs)
  );

  checks.push(await checkCommand(
    commandRunner,
    options.moltnetCliCommand ?? "moltnet",
    ["--help"],
    commandTimeoutMs,
    CHECK_IDS.moltnetCli,
    "Moltnet CLI"
  ));

  checks.push(await checkMoltnetServer(
    fetcher,
    options.moltnetServerUrl ?? DEFAULT_MOLTNET_SERVER_URL,
    fetchTimeoutMs
  ));

  checks.push(await checkRuntimeAssets(runtimeAssetRoot, "openclaw"));
  checks.push(await checkRuntimeAssets(runtimeAssetRoot, "picoclaw"));
  const compileProbe = options.compileProbe ?? probeCompileEvidence;
  const compileEvidence = await compileProbe(mixedRuntimeFixtureDirectory, commandTimeoutMs);
  checks.push(compileEvidence.moltnet);
  checks.push(compileEvidence.mneme);
  checks.push(compileEvidence.daimon);
  checks.push(compileEvidence.openclaw);
  checks.push(compileEvidence.picoclaw);

  const summary = checks.reduce(
    (accumulator, check) => {
      if (check.status === PASS) accumulator.passed += 1;
      if (check.status === SKIP) accumulator.skipped += 1;
      if (check.status === FAIL) accumulator.unavailable += 1;
      return accumulator;
    },
    { passed: 0, skipped: 0, unavailable: 0 }
  );

  return {
    checks,
    readyForLive: summary.unavailable === 0,
    summary: {
      ...summary,
      total: checks.length
    }
  };
};
