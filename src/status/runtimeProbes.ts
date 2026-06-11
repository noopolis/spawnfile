import type { DeploymentRecord, DockerInspectionResult, DockerProbeExecFile } from "../deployment/index.js";
import { createDockerProbeGateway } from "../deployment/index.js";
import type { ContainerRuntimeInstanceReport } from "../report/index.js";
import { getRuntimeAdapter } from "../runtime/index.js";
import type { RuntimeProbeObservation } from "../runtime/index.js";
import type { LoadedCompileReport, StatusReportRuntimeInstance } from "./compileReport.js";
import type { StatusObservation, StatusSeverity } from "./types.js";

export type StatusRuntimeInspections = Map<string, DockerInspectionResult>;

export interface CollectRuntimeProbeOptions {
  deployments: DeploymentRecord[];
  dockerCommand?: string;
  execFile?: DockerProbeExecFile;
  inspections: StatusRuntimeInspections;
  loadedReport: LoadedCompileReport;
  timeoutMs?: number;
}

const createObservation = (
  input: Omit<StatusObservation, "label" | "source">
): StatusObservation => ({
  ...input,
  label: `${input.severity.toUpperCase()} ${input.key}`,
  source: "runtime"
});

const instanceSubject = (instanceId: string): string => `runtime-instance:${instanceId}`;

const fromProbeObservation = (
  instance: StatusReportRuntimeInstance,
  probe: RuntimeProbeObservation
): StatusObservation =>
  createObservation({
    ...(probe.details ? { details: probe.details } : {}),
    key: probe.key,
    message: probe.message,
    severity: probe.severity,
    subject: instanceSubject(instance.id)
  });

const toRuntimeInstanceReport = (
  instance: StatusReportRuntimeInstance
): ContainerRuntimeInstanceReport => ({
  config_path: instance.configPath ?? "",
  home_path: instance.homePath,
  id: instance.id,
  internal_port: instance.internalPort,
  model_auth_methods: {},
  model_secrets_required: [],
  node_ids: instance.nodeIds,
  published_port: instance.publishedPort,
  runtime: instance.runtime,
  workspace_path: instance.workspacePath ?? undefined
});

const skippedSeverity = (running: boolean | null | undefined): StatusSeverity =>
  running === false ? "error" : "unknown";

export const collectRuntimeProbeObservations = async (
  options: CollectRuntimeProbeOptions
): Promise<StatusObservation[]> => {
  if (options.loadedReport.kind !== "loaded") {
    return [];
  }

  const observations: StatusObservation[] = [];
  const instances = new Map(
    options.loadedReport.report.runtimeInstances.map((instance) => [instance.id, instance])
  );

  for (const deployment of options.deployments) {
    const deploymentInspections = options.inspections.get(deployment.name);
    for (const unit of deployment.units) {
      const inspection = deploymentInspections?.get(unit.id);
      for (const instanceId of unit.runtime_instances) {
        const instance = instances.get(instanceId);
        if (!instance) {
          observations.push(createObservation({
            key: "runtime.instance",
            message: `${instanceId} is referenced by deployment ${deployment.name}/${unit.id} but missing from the compile report`,
            severity: "warn",
            subject: instanceSubject(instanceId)
          }));
          continue;
        }

        if (inspection?.running !== true) {
          observations.push(createObservation({
            key: "runtime.probe",
            message: `${instance.id} runtime probe skipped because deployment unit ${unit.id} is not running`,
            severity: skippedSeverity(inspection?.running),
            subject: instanceSubject(instance.id)
          }));
          continue;
        }

        let adapter;
        try {
          adapter = getRuntimeAdapter(instance.runtime);
        } catch (error) {
          observations.push(createObservation({
            key: "runtime.adapter",
            message: error instanceof Error ? error.message : String(error),
            severity: "unknown",
            subject: instanceSubject(instance.id)
          }));
          continue;
        }

        if (!adapter.statusProbes || adapter.statusProbes.length === 0) {
          observations.push(createObservation({
            key: "runtime.probe",
            message: `${instance.runtime} has no status probes`,
            severity: "unknown",
            subject: instanceSubject(instance.id)
          }));
          continue;
        }

        const manager = createDockerProbeGateway(deployment, unit, {
          dockerCommand: options.dockerCommand,
          execFile: options.execFile,
          inspection,
          timeoutMs: options.timeoutMs
        });
        for (const probe of adapter.statusProbes) {
          try {
            const probeObservations = await probe.run({
              deployment,
              instance: toRuntimeInstanceReport(instance),
              manager,
              timeoutMs: options.timeoutMs ?? 10_000,
              unit
            });
            observations.push(...probeObservations.map((entry) => fromProbeObservation(instance, entry)));
          } catch (error) {
            observations.push(createObservation({
              key: `runtime.${probe.id}`,
              message: `${probe.label} probe failed: ${error instanceof Error ? error.message : String(error)}`,
              severity: "unknown",
              subject: instanceSubject(instance.id)
            }));
          }
        }
      }
    }
  }

  return observations;
};
