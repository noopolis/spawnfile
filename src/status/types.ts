import type { OrganizationView } from "../compiler/index.js";

export type StatusSeverity = "error" | "ok" | "unknown" | "warn";
export type StatusExitCode = 0 | 1 | 2;
export type StatusOutputMode = "json" | "pretty" | "quiet";
export type StatusSelectorKind = "agent" | "network" | "runtime" | "team";

export interface StatusObservation {
  details?: Record<string, unknown>;
  key: string;
  label: string;
  message: string;
  severity: StatusSeverity;
  source: "compile_report" | "declared" | "deployment" | "input" | "network" | "runtime";
  subject: string;
}

export interface StatusObservationCounts {
  error: number;
  ok: number;
  unknown: number;
  warn: number;
}

export interface StatusSelection {
  kind: StatusSelectorKind;
  label: string;
  subjectKeys: string[];
  value: string;
}

export interface StatusInputFailure {
  exitCode: 2;
  message: string;
}

export interface StatusCompileReportInfo {
  compileFingerprint: string | null;
  generatedAt: string | null;
  outputDirectory: string | null;
  path: string;
  present: boolean;
  root: string | null;
}

export interface StaticStatusSummary {
  agents: number;
  deployments: number;
  networks: number;
  runtimes: number;
  teams: number;
}

export interface StatusDeploymentUnitLive {
  checked: boolean;
  containerId: string | null;
  drift: string[];
  exists: boolean | null;
  exitCode: number | null;
  finishedAt: string | null;
  imageId: string | null;
  message: string;
  restartCount: number | null;
  running: boolean | null;
  severity: StatusSeverity;
  startedAt: string | null;
  status: string | null;
}

export interface StatusDeploymentUnitSummary {
  containerId: string | null;
  containerName: string | null;
  contains: Array<{ id: string; kind: string }>;
  id: string;
  imageId: string | null;
  imageTag: string;
  kind: "container";
  live: StatusDeploymentUnitLive | null;
  runtimeInstances: string[];
}

export interface StatusDeploymentSummary {
  authProfile: string | null;
  compileFingerprint: string;
  createdAt: string;
  manager: "docker";
  name: string;
  recordPath: string;
  target: string;
  units: StatusDeploymentUnitSummary[];
}

export interface StatusLiveRequest {
  context: string | null;
  deploymentName: string | null;
  logs: boolean;
  recover: boolean;
  requested: boolean;
}

export interface StaticStatus {
  compile: StatusCompileReportInfo;
  deployments: StatusDeploymentSummary[];
  inputPath: string;
  live: StatusLiveRequest;
  observations: StatusObservation[];
  outputDirectory: string;
  projectRoot: string | null;
  selection: StatusSelection | null;
  summary: StaticStatusSummary;
  view: OrganizationView;
  version: "spawnfile.status.v1";
}

export interface StatusCommandResult {
  error?: string;
  exitCode: StatusExitCode;
  output?: string;
  status?: StaticStatus;
}

export interface StatusRenderOptions {
  mode: StatusOutputMode;
}
