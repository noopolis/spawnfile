import {
  readDockerDeploymentLogs,
  type DeploymentRecord,
  type DockerLogsExecFile
} from "../deployment/index.js";
import type { LoadedCompileReport } from "./compileReport.js";
import type { StatusObservation } from "./types.js";

export interface CollectDeploymentLogOptions {
  deployments: DeploymentRecord[];
  dockerCommand?: string;
  execFile?: DockerLogsExecFile;
  loadedReport: LoadedCompileReport;
  tail?: number;
  timeoutMs?: number;
}

const createObservation = (
  input: Omit<StatusObservation, "label" | "source">
): StatusObservation => ({
  ...input,
  label: `${input.severity.toUpperCase()} ${input.key}`,
  source: "deployment"
});

const secretValuesFor = (loadedReport: LoadedCompileReport): string[] => {
  if (loadedReport.kind !== "loaded") {
    return [];
  }

  return (loadedReport.report.secretsRequired ?? [])
    .map((secretName) => process.env[secretName])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
};

const normalizeFailureSeverity = (
  severity: StatusObservation["severity"]
): StatusObservation["severity"] =>
  severity === "error" ? "unknown" : severity;

export const collectDeploymentLogObservations = async (
  options: CollectDeploymentLogOptions
): Promise<StatusObservation[]> => {
  const secretValues = secretValuesFor(options.loadedReport);
  const observations: StatusObservation[] = [];

  for (const deployment of options.deployments) {
    const logs = await readDockerDeploymentLogs(deployment, {
      dockerCommand: options.dockerCommand,
      execFile: options.execFile,
      secretValues,
      tail: options.tail,
      timeoutMs: options.timeoutMs
    });
    for (const unit of deployment.units) {
      const unitLogs = logs.get(unit.id);
      if (!unitLogs) {
        continue;
      }
      observations.push(createObservation({
        details: {
          container_ref: unitLogs.containerRef,
          log_tail: unitLogs.text
        },
        key: "deployment.logs",
        message: `${deployment.name}/${unit.id}: ${unitLogs.message}`,
        severity: normalizeFailureSeverity(unitLogs.severity),
        subject: `deployment-unit:${deployment.name}:${unit.id}`
      }));
    }
  }

  return observations;
};
