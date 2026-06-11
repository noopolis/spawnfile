import type {
  DeploymentRecord,
  DockerInspectionResult,
  DockerUnitInspection
} from "../deployment/index.js";
import type {
  StatusDeploymentSummary,
  StatusDeploymentUnitLive,
  StatusDeploymentUnitSummary,
  StatusObservation,
  StatusSeverity
} from "./types.js";

export interface LoadedDeploymentRecord {
  path: string;
  record: DeploymentRecord;
}

export type StatusDeploymentInspections = Map<string, DockerInspectionResult>;

const createObservation = (
  input: Omit<StatusObservation, "label">
): StatusObservation => ({
  ...input,
  label: `${input.severity.toUpperCase()} ${input.key}`
});

const targetLabelFor = (record: DeploymentRecord): string =>
  record.target.kind === "context"
    ? `docker context ${record.target.name}`
    : record.target.kind === "docker-context"
      ? `docker context ${record.target.context}`
      : "docker host";

const liveForInspection = (
  inspection: DockerUnitInspection | undefined
): StatusDeploymentUnitLive | null => {
  if (!inspection) {
    return null;
  }

  return {
    checked: true,
    containerId: inspection.containerId,
    drift: [...inspection.drift],
    exists: inspection.exists,
    exitCode: inspection.exitCode,
    finishedAt: inspection.finishedAt,
    imageId: inspection.imageId,
    message: inspection.message,
    restartCount: inspection.restartCount,
    running: inspection.running,
    severity: inspection.severity,
    startedAt: inspection.startedAt,
    status: inspection.status
  };
};

const unitSeverity = (live: StatusDeploymentUnitLive | null): StatusSeverity => {
  if (!live) {
    return "ok";
  }
  if (live.severity !== "ok") {
    return live.severity;
  }
  if (live.running === true) {
    return "ok";
  }
  if (live.exists === false) {
    return "warn";
  }
  if (live.running === false) {
    return "error";
  }
  return "unknown";
};

const summarizeUnit = (
  unit: DeploymentRecord["units"][number],
  live: StatusDeploymentUnitLive | null
): StatusDeploymentUnitSummary => ({
  containerId: unit.container_id,
  containerName: unit.container_name,
  contains: unit.contains.map((entry) => ({ id: entry.id, kind: entry.kind })),
  id: unit.id,
  imageId: unit.image_id,
  imageTag: unit.image_tag,
  kind: unit.kind,
  live,
  runtimeInstances: [...unit.runtime_instances]
});

export const createDeploymentSummaries = (
  records: LoadedDeploymentRecord[],
  inspections: StatusDeploymentInspections = new Map()
): StatusDeploymentSummary[] =>
  records.map(({ path, record }) => ({
    authProfile: record.auth_profile,
    compileFingerprint: record.compile_fingerprint,
    createdAt: record.created_at,
    manager: record.manager,
    name: record.name,
    recordPath: path,
    target: targetLabelFor(record),
    units: record.units.map((unit) => summarizeUnit(
      unit,
      liveForInspection(inspections.get(record.name)?.get(unit.id))
    ))
  }));

export const createDeploymentObservations = (
  deployments: StatusDeploymentSummary[],
  options: {
    compileFingerprint: string | null;
    liveRequested: boolean;
    outputDirectory: string;
    recover: boolean;
  }
): StatusObservation[] => {
  const observations: StatusObservation[] = [];

  if (deployments.length === 0 && options.liveRequested && !options.recover) {
    observations.push(createObservation({
      key: "deployment.record",
      message: `No deployment records found under ${options.outputDirectory}`,
      severity: "warn",
      source: "deployment",
      subject: "deployment"
    }));
  }

  if (options.recover) {
    observations.push(createObservation({
      key: "deployment.recover",
      message: "Label recovery is not implemented yet; use record-backed status for live checks",
      severity: "unknown",
      source: "deployment",
      subject: "deployment"
    }));
  }

  for (const deployment of deployments) {
    observations.push(createObservation({
      key: "deployment.record",
      message: `${deployment.name} record exists at ${deployment.recordPath}`,
      severity: "ok",
      source: "deployment",
      subject: `deployment:${deployment.name}`
    }));

    if (options.compileFingerprint && deployment.compileFingerprint !== options.compileFingerprint) {
      observations.push(createObservation({
        key: "deployment.compile_fingerprint",
        message: `${deployment.name} was deployed from ${deployment.compileFingerprint}, current compile is ${options.compileFingerprint}`,
        severity: "warn",
        source: "deployment",
        subject: `deployment:${deployment.name}`
      }));
    }

    for (const unit of deployment.units) {
      const severity = unitSeverity(unit.live);
      const unitSubject = `deployment-unit:${deployment.name}:${unit.id}`;
      observations.push(createObservation({
        key: "deployment.unit",
        message: unit.live?.message ?? `${unit.id} recorded for ${deployment.target}`,
        severity,
        source: "deployment",
        subject: unitSubject
      }));

      for (const entry of unit.contains) {
        observations.push(createObservation({
          key: "deployment.hosting",
          message: `${entry.id} is hosted by ${deployment.name}/${unit.id}`,
          severity,
          source: "deployment",
          subject: entry.id
        }));
      }
    }
  }

  return observations;
};
