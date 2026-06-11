import path from "node:path";

import {
  renderOrganizationTree,
  type OrganizationNetworkView,
  type OrganizationRuntimeView,
  type OrganizationViewTreeNode
} from "../compiler/index.js";
import { countObservations, getVisibleObservations } from "./buildStatus.js";
import type {
  StaticStatus,
  StatusDeploymentSummary,
  StatusObservation,
  StatusObservationCounts,
  StatusRenderOptions,
  StatusSeverity
} from "./types.js";
import { flattenOrganizationNodes } from "./traversal.js";

const SEVERITY_ORDER: StatusSeverity[] = ["error", "warn", "unknown", "ok"];

const relativePath = (value: string, root: string | null): string =>
  root ? path.relative(root, value) || "." : value;

const formatCounts = (counts: StatusObservationCounts): string =>
  `${counts.ok} ok, ${counts.warn} warn, ${counts.error} error, ${counts.unknown} unknown`;

const severityForSubject = (
  observations: StatusObservation[],
  subject: string,
  source?: StatusObservation["source"]
): StatusSeverity => {
  const subjectObservations = observations.filter((observation) =>
    observation.subject === subject && (!source || observation.source === source)
  );
  for (const severity of SEVERITY_ORDER) {
    if (subjectObservations.some((observation) => observation.severity === severity)) {
      return severity;
    }
  }
  return "unknown";
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const humanizeMessagePaths = (message: string, projectRoot: string | null): string => {
  if (!projectRoot) {
    return message;
  }

  return message.replace(new RegExp(escapeRegExp(projectRoot), "g"), ".");
};

const formatObservation = (
  observation: StatusObservation,
  projectRoot: string | null
): string =>
  `[${observation.severity}] ${observation.subject} ${observation.key}: ${
    humanizeMessagePaths(observation.message, projectRoot)
  }`;

const nonOkObservations = (observations: StatusObservation[]): StatusObservation[] =>
  observations.filter((observation) => observation.severity !== "ok");

const observationsWithDetails = (observations: StatusObservation[]): StatusObservation[] =>
  observations.filter((observation) =>
    observation.details && Object.keys(observation.details).length > 0
  );

const formatDetailValue = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

const formatObservationDetails = (
  observation: StatusObservation,
  projectRoot: string | null
): string[] => {
  const details = observation.details ?? {};
  const lines = [`  ${formatObservation(observation, projectRoot)}`];
  const logTail = details.log_tail;
  if (typeof logTail === "string") {
    lines.push("    log_tail:");
    const text = logTail.replace(/\n$/u, "");
    if (text.length === 0) {
      lines.push("      (empty)");
    } else {
      lines.push(...text.split("\n").map((line) => `      ${humanizeMessagePaths(line, projectRoot)}`));
    }
  }

  for (const [key, value] of Object.entries(details)) {
    if (key === "log_tail") {
      continue;
    }
    lines.push(`    ${key}: ${humanizeMessagePaths(formatDetailValue(value), projectRoot)}`);
  }
  return lines;
};

const formatDocRoles = (node: OrganizationViewTreeNode): string =>
  node.declared?.docs.map((doc) => doc.role).sort().join(", ") || "none";

const formatNodeDetails = (
  node: OrganizationViewTreeNode,
  observations: StatusObservation[],
  projectRoot: string | null
): string[] => {
  const declared = node.declared;
  const details = [
    `  ${node.name} (${node.id})${node.runtimeName ? ` runtime=${node.runtimeName}` : ""}`,
    `    source: ${relativePath(node.source, projectRoot)}`,
    `    declared: ${severityForSubject(observations, node.id, "declared")}`,
    `    compiled: ${severityForSubject(observations, node.id, "compile_report")}`,
    `    docs: ${formatDocRoles(node)}`
  ];

  if (!declared) {
    return details;
  }

  details.push(`    skills: ${declared.skills.map((skill) => skill.name).join(", ") || "none"}`);
  details.push(
    `    resources: ${declared.resources.map((resource) =>
      `${resource.id}@${resource.mount}(${resource.sharing})`).join(", ") || "none"}`
  );
  details.push(`    packages: ${declared.packages.map((pkg) => pkg.id).join(", ") || "none"}`);
  details.push(
    `    mcp: ${declared.mcpServers.map((server) =>
      `${server.name}:${server.transport}`).join(", ") || "none"}`
  );
  details.push(`    model: ${declared.model
    ? `${declared.model.provider}/${declared.model.name} auth=${declared.model.authMethod}`
    : "none"}`);
  details.push(`    schedule: ${declared.schedule
    ? `${declared.schedule.kind}${declared.schedule.expression ? ` ${declared.schedule.expression}` : ""}`
    : "none"}`);
  details.push(
    `    surfaces: ${declared.surfaces.map((surface) =>
      `${surface.name}[${surface.scopes.join(",")}]`).join(", ") || "none"}`
  );
  details.push(`    policy: mode=${declared.policy.mode ?? "default"} on_degrade=${declared.policy.onDegrade ?? "default"}`);
  return details;
};

const formatNetwork = (
  network: OrganizationNetworkView,
  observations: StatusObservation[]
): string[] => [
  `  ${network.id} "${network.name}"`,
  `    declared: ${severityForSubject(observations, `network:${network.id}`, "declared")}`,
  `    provider: ${network.provider}`,
  `    server: ${network.serverMode ?? "unspecified"}`,
  `    rooms: ${network.rooms.map((room) => `${room.id}[${room.declaredMembers.join(",")}]`).join(", ") || "none"}`
];

const formatRuntime = (
  runtime: OrganizationRuntimeView,
  observations: StatusObservation[]
): string[] => [
  `  ${runtime.name}`,
  `    declared: ${severityForSubject(observations, `runtime:${runtime.name}`, "declared")}`,
  `    nodes: ${runtime.nodeIds.join(", ") || "none"}`
];

const formatDeployment = (
  deployment: StatusDeploymentSummary,
  projectRoot: string | null
): string[] => [
  `  ${deployment.name} ${deployment.manager} ${deployment.target}`,
  `    record: ${relativePath(deployment.recordPath, projectRoot)}`,
  `    compile: ${deployment.compileFingerprint}`,
  `    created: ${deployment.createdAt}`,
  `    auth-profile: ${deployment.authProfile ?? "none"}`,
  ...deployment.units.flatMap((unit) => [
    `    unit ${unit.id}`,
    `      image: ${unit.imageTag}${unit.imageId ? ` (${unit.imageId})` : ""}`,
    `      container: ${unit.containerName ?? "none"}${unit.containerId ? ` (${unit.containerId})` : ""}`,
    `      contains: ${unit.contains.map((entry) => entry.id).join(", ") || "none"}`,
    `      runtimes: ${unit.runtimeInstances.join(", ") || "none"}`,
    `      live: ${unit.live ? unit.live.message : "not checked"}`
  ])
];

const renderHeader = (
  status: StaticStatus,
  observations: StatusObservation[]
): string[] => {
  const counts = countObservations(observations);
  return [
    `Spawnfile status: ${relativePath(status.inputPath, status.projectRoot)}`,
    `Output: ${relativePath(status.outputDirectory, status.projectRoot)}`,
    `Summary: ${status.summary.agents} agents, ${status.summary.teams} teams, ${status.summary.networks} networks, ${status.summary.runtimes} runtimes, ${status.summary.deployments} deployments`,
    `Status: ${formatCounts(counts)}`,
    status.live.requested ? `Live: requested${status.live.deploymentName ? ` deployment=${status.live.deploymentName}` : ""}` : "",
    status.selection ? `Selection: ${status.selection.kind} ${status.selection.label}` : ""
  ].filter(Boolean);
};

const selectedNodes = (status: StaticStatus): OrganizationViewTreeNode[] => {
  const nodes = flattenOrganizationNodes(status.view);
  if (!status.selection) {
    return nodes;
  }
  if (status.selection.kind === "agent" || status.selection.kind === "team") {
    const subjects = new Set(status.selection.subjectKeys);
    return nodes.filter((node) => subjects.has(node.id));
  }
  if (status.selection.kind === "runtime") {
    const subjects = new Set(status.selection.subjectKeys);
    return nodes.filter((node) => subjects.has(node.id));
  }
  return [];
};

const selectedNetworks = (status: StaticStatus): OrganizationNetworkView[] => {
  if (status.selection?.kind !== "network") {
    return status.selection ? [] : status.view.networks;
  }
  const subjects = new Set(status.selection.subjectKeys);
  return status.view.networks.filter((network) => subjects.has(`network:${network.id}`));
};

const selectedRuntimes = (status: StaticStatus): OrganizationRuntimeView[] => {
  if (status.selection?.kind !== "runtime") {
    return status.selection ? [] : status.view.runtimes;
  }
  return status.view.runtimes.filter((runtime) => runtime.name === status.selection?.value);
};

const selectedDeployments = (status: StaticStatus): StatusDeploymentSummary[] => {
  if (!status.selection) {
    return status.deployments;
  }
  if (status.selection.kind === "network") {
    return [];
  }

  const subjects = new Set(status.selection.subjectKeys);
  return status.deployments.filter((deployment) =>
    deployment.units.some((unit) =>
      unit.contains.some((entry) => subjects.has(entry.id))
      || unit.runtimeInstances.some((runtimeInstance) => subjects.has(`runtime-instance:${runtimeInstance}`))
    )
  );
};

const renderPrettyStatus = (status: StaticStatus): string => {
  const observations = getVisibleObservations(status);
  const annotations = (subject: string): string[] => {
    const severity = severityForSubject(observations, subject);
    return [`status=${severity}`];
  };
  const lines = [
    ...renderHeader(status, observations),
    "",
    `Compile: ${status.compile.present ? "present" : "missing"} ${relativePath(status.compile.path, status.projectRoot)}`
  ];

  if (!status.selection) {
    lines.push("", "Organization", renderOrganizationTree(status.view, { annotationFor: annotations }));
  }

  const deployments = selectedDeployments(status);
  if (deployments.length > 0) {
    lines.push("", "Deployments", ...deployments.flatMap((deployment) =>
      formatDeployment(deployment, status.projectRoot)));
  }

  const nodes = selectedNodes(status);
  if (nodes.length > 0) {
    lines.push("", "Nodes", ...nodes.flatMap((node) =>
      formatNodeDetails(node, observations, status.projectRoot)));
  }

  const networks = selectedNetworks(status);
  if (networks.length > 0) {
    lines.push("", "Networks", ...networks.flatMap((network) => formatNetwork(network, observations)));
  }

  const runtimes = selectedRuntimes(status);
  if (runtimes.length > 0) {
    lines.push("", "Runtimes", ...runtimes.flatMap((runtime) => formatRuntime(runtime, observations)));
  }

  const notable = nonOkObservations(observations);
  if (notable.length > 0) {
    lines.push("", "Observations", ...notable.map((observation) =>
      `  ${formatObservation(observation, status.projectRoot)}`));
  }

  const details = observationsWithDetails(observations);
  if (details.length > 0) {
    lines.push("", "Details", ...details.flatMap((observation) =>
      formatObservationDetails(observation, status.projectRoot)));
  }

  return lines.join("\n");
};

const renderQuietStatus = (status: StaticStatus): string => {
  const observations = getVisibleObservations(status);
  const notable = nonOkObservations(observations);
  return [
    ...renderHeader(status, observations),
    ...notable.map((observation) => formatObservation(observation, status.projectRoot))
  ].join("\n");
};

const renderJsonStatus = (status: StaticStatus): string =>
  JSON.stringify({
    compile: status.compile,
    deployments: status.deployments,
    input_path: status.inputPath,
    live: status.live,
    observations: getVisibleObservations(status),
    output_directory: status.outputDirectory,
    project_root: status.projectRoot,
    selection: status.selection,
    summary: status.summary,
    version: status.version,
    view: status.view
  }, null, 2);

export const renderStatus = (
  status: StaticStatus,
  options: StatusRenderOptions
): string => {
  if (options.mode === "json") {
    return renderJsonStatus(status);
  }
  return options.mode === "quiet" ? renderQuietStatus(status) : renderPrettyStatus(status);
};
