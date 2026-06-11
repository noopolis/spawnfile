import type { LoadedCompileReport } from "./compileReport.js";
import type { StatusObservation } from "./types.js";

const createObservation = (
  input: Omit<StatusObservation, "label">
): StatusObservation => ({
  ...input,
  label: `${input.severity.toUpperCase()} ${input.key}`
});

export const createCompiledContainerObservations = (
  loaded: Extract<LoadedCompileReport, { kind: "loaded" }>
): StatusObservation[] => {
  const observations: StatusObservation[] = [];
  const report = loaded.report;

  for (const instance of report.runtimeInstances) {
    observations.push(createObservation({
      key: "runtime.instance",
      message: `${instance.id} emits ${instance.runtime} workspace ${instance.workspacePath ?? "unknown"}`,
      severity: "ok",
      source: "compile_report",
      subject: `runtime-instance:${instance.id}`
    }));
  }

  for (const server of report.moltnetServers ?? []) {
    observations.push(createObservation({
      key: "network.compiled",
      message: `${server.networkId} Moltnet ${server.mode} server at ${server.baseUrl}`,
      severity: "ok",
      source: "compile_report",
      subject: `network:${server.networkId}`
    }));
    for (const room of server.rooms) {
      observations.push(createObservation({
        key: "network.room.compiled",
        message: `${server.networkId}/${room.id} expects ${room.members.length} member(s)`,
        severity: "ok",
        source: "compile_report",
        subject: `room:${server.networkId}:${room.id}`
      }));
    }
  }

  for (const mount of report.persistentMounts ?? []) {
    observations.push(createObservation({
      key: "container.mount",
      message: `${mount.id} mounted at ${mount.mountPath} using volume ${mount.volumeName}`,
      severity: "ok",
      source: "compile_report",
      subject: "compile"
    }));
  }

  for (const resource of report.workspaceResources ?? []) {
    observations.push(createObservation({
      key: "workspace.resource",
      message: `${resource.id} linked at ${resource.linkPath} from ${resource.backingPath}`,
      severity: "ok",
      source: "compile_report",
      subject: "compile"
    }));
  }

  if ((report.internalPorts?.length ?? 0) > 0 || (report.publishedPorts?.length ?? 0) > 0) {
    observations.push(createObservation({
      key: "container.ports",
      message: `internal ports: ${(report.internalPorts ?? []).join(", ") || "none"}; published ports: ${(report.publishedPorts ?? []).join(", ") || "none"}`,
      severity: "ok",
      source: "compile_report",
      subject: "compile"
    }));
  }

  return observations;
};
