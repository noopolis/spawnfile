import type { DeploymentRecord, DockerInspectionResult, DockerProbeExecFile } from "../deployment/index.js";
import { createDockerProbeGateway } from "../deployment/index.js";
import type { LoadedCompileReport, StatusReportMoltnetServerPlan } from "./compileReport.js";
import type { StatusObservation } from "./types.js";

export type StatusNetworkInspections = Map<string, DockerInspectionResult>;

export interface MoltnetHealthResponse {
  error?: string;
  ok: boolean;
}

export type MoltnetHealthFetch = (
  url: string,
  timeoutMs: number
) => Promise<MoltnetHealthResponse>;

export interface CollectMoltnetProbeOptions {
  /** Compatibility-only until the out-of-scope CLI stops resolving status auth. */
  authValues?: Record<string, string>;
  deployments: DeploymentRecord[];
  execFile?: DockerProbeExecFile;
  fetchHealth?: MoltnetHealthFetch;
  inspections: StatusNetworkInspections;
  loadedReport: LoadedCompileReport;
  timeoutMs?: number;
}

const createObservation = (
  input: Omit<StatusObservation, "label" | "source">
): StatusObservation => ({
  ...input,
  label: `${input.severity.toUpperCase()} ${input.key}`,
  source: "network"
});

const defaultFetchHealth: MoltnetHealthFetch = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok
      ? { ok: true }
      : { error: `HTTP ${response.status}`, ok: false };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ok: false };
  } finally {
    clearTimeout(timer);
  }
};

const createManagedGateway = (
  deployments: DeploymentRecord[],
  inspections: StatusNetworkInspections,
  options: CollectMoltnetProbeOptions
) => {
  for (const deployment of deployments) {
    const inspectionMap = inspections.get(deployment.name);
    const unit = deployment.units[0];
    if (!unit) continue;
    const inspection = inspectionMap?.get(unit.id);
    if (inspection?.running === true) {
      return createDockerProbeGateway(deployment, unit, {
        execFile: options.execFile,
        inspection,
        timeoutMs: options.timeoutMs
      });
    }
  }
  return null;
};

const healthForServer = async (
  server: StatusReportMoltnetServerPlan,
  options: CollectMoltnetProbeOptions
): Promise<MoltnetHealthResponse> => {
  if (server.mode === "managed") {
    const gateway = createManagedGateway(options.deployments, options.inspections, options);
    if (!gateway) return { error: "no running deployment unit hosts the managed Moltnet server", ok: false };
    if (!server.port) return { error: "managed Moltnet server has no internal port", ok: false };
    const response = await gateway.httpGet(server.port, "/healthz");
    return response.ok ? { ok: true } : { error: response.error, ok: false };
  }
  return (options.fetchHealth ?? defaultFetchHealth)(
    `${server.baseUrl.replace(/\/$/u, "")}/healthz`,
    options.timeoutMs ?? 10_000
  );
};

export const collectMoltnetProbeObservations = async (
  options: CollectMoltnetProbeOptions
): Promise<StatusObservation[]> => {
  if (options.loadedReport.kind !== "loaded") return [];

  // authValues is intentionally unread and unused; status is health-only.
  const observations: StatusObservation[] = [];
  for (const server of options.loadedReport.report.moltnetServers ?? []) {
    const response = await healthForServer(server, options);
    observations.push(createObservation({
      key: "network.reachable",
      message: response.ok
        ? `${server.networkId} public health endpoint responded`
        : `${server.networkId} public health endpoint unavailable: ${response.error ?? "unknown failure"}`,
      severity: response.ok ? "ok" : "unknown",
      subject: `network:${server.networkId}`
    }));
  }
  return observations;
};
