import path from "node:path";

import {
  type LoadedCompileReport,
  type StatusReportCapability,
  type StatusReportDiagnostic,
  type StatusReportNode
} from "./compileReport.js";
import type {
  StaticStatus,
  StatusCompileReportInfo,
  StatusDeploymentSummary,
  StatusExitCode,
  StatusLiveRequest,
  StatusObservation,
  StatusObservationCounts,
  StatusSelection,
  StatusSeverity
} from "./types.js";
import { createCompiledContainerObservations } from "./compiledContainerObservations.js";
import { createDeploymentObservations } from "./deployments.js";
import { expandStatusSelectionSubjects } from "./selectionSubjects.js";
import { countNodesByKind, flattenOrganizationNodes } from "./traversal.js";

export const countObservations = (
  observations: StatusObservation[]
): StatusObservationCounts => ({
  error: observations.filter((observation) => observation.severity === "error").length,
  ok: observations.filter((observation) => observation.severity === "ok").length,
  unknown: observations.filter((observation) => observation.severity === "unknown").length,
  warn: observations.filter((observation) => observation.severity === "warn").length
});

export const getVisibleObservations = (
  status: StaticStatus
): StatusObservation[] => {
  if (!status.selection) {
    return status.observations;
  }

  const subjects = new Set(["compile", "status", ...status.selection.subjectKeys]);
  return status.observations.filter((observation) => subjects.has(observation.subject));
};

export const exitCodeForStatus = (status: StaticStatus): StatusExitCode =>
  getVisibleObservations(status).some((observation) => observation.severity === "error")
    ? 1
    : 0;

const severityForDiagnostic = (diagnostic: StatusReportDiagnostic): StatusSeverity =>
  diagnostic.level === "error" ? "error" : diagnostic.level === "warn" ? "warn" : "ok";

const severityForCapability = (capability: StatusReportCapability): StatusSeverity =>
  capability.outcome === "unsupported"
    ? "error"
    : capability.outcome === "degraded"
      ? "warn"
      : "ok";

const createNodeReportObservations = (node: StatusReportNode): StatusObservation[] => {
  const observations: StatusObservation[] = [];

  for (const diagnostic of node.diagnostics) {
    observations.push({
      key: `diagnostic.${diagnostic.level}`,
      label: node.id,
      message: diagnostic.message,
      severity: severityForDiagnostic(diagnostic),
      source: "compile_report",
      subject: node.id
    });
  }

  for (const capability of node.capabilities) {
    const severity = severityForCapability(capability);
    if (severity === "ok") {
      continue;
    }

    observations.push({
      key: `capability.${capability.key}`,
      label: node.id,
      message: capability.message,
      severity,
      source: "compile_report",
      subject: node.id
    });
  }

  return observations;
};

const createObservation = (
  input: Omit<StatusObservation, "label">
): StatusObservation => ({
  ...input,
  label: `${input.severity.toUpperCase()} ${input.key}`
});

const compileInfoFor = (loaded: LoadedCompileReport): StatusCompileReportInfo => {
  if (loaded.kind !== "loaded") {
    return {
      compileFingerprint: null,
      generatedAt: null,
      outputDirectory: null,
      path: loaded.reportPath,
      present: false,
      root: null
    };
  }

  return {
    compileFingerprint: loaded.report.compileFingerprint,
    generatedAt: loaded.report.generatedAt,
    outputDirectory: loaded.report.outputDirectory,
    path: loaded.reportPath,
    present: true,
    root: loaded.report.root
  };
};

const addDeclaredObservations = (
  observations: StatusObservation[],
  view: StaticStatus["view"],
  nodes: ReturnType<typeof flattenOrganizationNodes>
): void => {
  observations.push(createObservation({
    key: "source.valid",
    message: `Loaded organization graph from ${view.root.source}`,
    severity: "ok",
    source: "declared",
    subject: "status"
  }));

  for (const node of nodes) {
    observations.push(createObservation({
      key: `${node.kind}.declared`,
      message: `${node.displayName} is declared`,
      severity: "ok",
      source: "declared",
      subject: node.id
    }));
  }

  for (const network of view.networks) {
    observations.push(createObservation({
      key: "network.declared",
      message: `${network.id} declares ${network.rooms.length} room(s)`,
      severity: "ok",
      source: "declared",
      subject: `network:${network.id}`
    }));
  }

  for (const runtime of view.runtimes) {
    observations.push(createObservation({
      key: "runtime.declared",
      message: `${runtime.name} serves ${runtime.nodeIds.length} node(s)`,
      severity: "ok",
      source: "declared",
      subject: `runtime:${runtime.name}`
    }));
  }
};

const addCompiledObservations = (
  observations: StatusObservation[],
  loaded: LoadedCompileReport,
  view: StaticStatus["view"],
  nodes: ReturnType<typeof flattenOrganizationNodes>
): void => {
  if (loaded.kind === "missing") {
    observations.push(createObservation({
      key: "compile.report",
      message: `Compile report not found at ${loaded.reportPath}`,
      severity: "unknown",
      source: "compile_report",
      subject: "compile"
    }));
    return;
  }

  if (loaded.kind === "failure") {
    observations.push(createObservation({
      key: "compile.report",
      message: loaded.failure.message,
      severity: "error",
      source: "input",
      subject: "compile"
    }));
    return;
  }

  observations.push(createObservation({
    key: "compile.report",
    message: `Loaded compile report ${loaded.report.reportPath}`,
    severity: "ok",
    source: "compile_report",
    subject: "compile"
  }));
  observations.push(createObservation({
    key: "compile.fingerprint",
    message: loaded.report.compileFingerprint
      ? `Compile fingerprint ${loaded.report.compileFingerprint}`
      : "Compile report has no compile_fingerprint yet",
    severity: loaded.report.compileFingerprint ? "ok" : "unknown",
    source: "compile_report",
    subject: "compile"
  }));
  observations.push(...createCompiledContainerObservations(loaded));
  if (loaded.report.root && path.resolve(loaded.report.root) !== path.resolve(view.root.source)) {
    observations.push(createObservation({
      key: "compile.root",
      message: `Compile report root ${loaded.report.root} differs from source ${view.root.source}`,
      severity: "warn",
      source: "compile_report",
      subject: "compile"
    }));
  }

  const reportNodes = new Map(loaded.report.nodes.map((node) => [node.id, node]));
  const declaredIds = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    const reportNode = reportNodes.get(node.id);
    observations.push(createObservation({
      key: `${node.kind}.compiled`,
      message: reportNode
        ? `${node.displayName} is present in the compile report`
        : `${node.displayName} is missing from the compile report`,
      severity: reportNode ? "ok" : "warn",
      source: "compile_report",
      subject: node.id
    }));
    if (reportNode) {
      observations.push(...createNodeReportObservations(reportNode));
    }
  }

  for (const reportNode of loaded.report.nodes) {
    if (!declaredIds.has(reportNode.id)) {
      observations.push(createObservation({
        key: "compile.extra_node",
        message: `${reportNode.id} appears in the compile report but not in source`,
        severity: "warn",
        source: "compile_report",
        subject: reportNode.id
      }));
    }
  }
};

const defaultLiveRequest = (): StatusLiveRequest => ({
  context: null,
  deploymentName: null,
  logs: false,
  recover: false,
  requested: false
});

const addLivePlaceholderObservations = (
  observations: StatusObservation[],
  view: StaticStatus["view"],
  live: StatusLiveRequest,
  providedLiveObservations: StatusObservation[]
): void => {
  if (!live.requested) {
    return;
  }

  if (!providedLiveObservations.some((observation) => observation.source === "runtime")) {
    for (const runtime of view.runtimes) {
      observations.push(createObservation({
        key: "runtime.probe",
        message: `${runtime.name} live runtime probe is not available for this status request`,
        severity: "unknown",
        source: "runtime",
        subject: `runtime:${runtime.name}`
      }));
    }
  }

  if (!providedLiveObservations.some((observation) => observation.source === "network")) {
    for (const network of view.networks) {
      observations.push(createObservation({
        key: "network.probe",
        message: `${network.id} live network probe is not available for this status request`,
        severity: "unknown",
        source: "network",
        subject: `network:${network.id}`
      }));
    }
  }
};

export const createStaticStatus = (
  view: StaticStatus["view"],
  loadedReport: LoadedCompileReport,
  input: {
    deployments?: StatusDeploymentSummary[];
    inputPath: string;
    liveObservations?: StatusObservation[];
    live?: StatusLiveRequest;
    outputDirectory: string;
    selection: StatusSelection | null;
  }
): StaticStatus => {
  const nodes = flattenOrganizationNodes(view);
  const observations: StatusObservation[] = [];
  const nodeCounts = countNodesByKind(nodes);
  const deployments = input.deployments ?? [];
  const live = input.live ?? defaultLiveRequest();
  const liveObservations = input.liveObservations ?? [];
  const selection = expandStatusSelectionSubjects(input.selection, {
    deployments,
    loadedReport,
    view
  });

  addDeclaredObservations(observations, view, nodes);
  addCompiledObservations(observations, loadedReport, view, nodes);
  observations.push(...createDeploymentObservations(deployments, {
    compileFingerprint: compileInfoFor(loadedReport).compileFingerprint,
    liveRequested: live.requested,
    outputDirectory: input.outputDirectory,
    recover: live.recover
  }));
  observations.push(...liveObservations);
  addLivePlaceholderObservations(observations, view, live, liveObservations);

  return {
    compile: compileInfoFor(loadedReport),
    deployments,
    inputPath: input.inputPath,
    live,
    observations,
    outputDirectory: input.outputDirectory,
    projectRoot: view.projectRoot ?? null,
    selection,
    summary: {
      ...nodeCounts,
      deployments: deployments.length,
      networks: view.networks.length,
      runtimes: view.runtimes.length
    },
    view,
    version: "spawnfile.status.v1"
  };
};
