import type { OrganizationView } from "../compiler/index.js";
import type { LoadedCompileReport } from "./compileReport.js";
import type { StatusDeploymentSummary, StatusSelection } from "./types.js";

const addRuntimeInstancesForNodes = (
  subjects: Set<string>,
  loadedReport: LoadedCompileReport,
  nodeIds: Set<string>
): void => {
  if (loadedReport.kind !== "loaded") {
    return;
  }

  for (const instance of loadedReport.report.runtimeInstances) {
    if (instance.nodeIds.some((nodeId) => nodeIds.has(nodeId))) {
      subjects.add(`runtime-instance:${instance.id}`);
    }
  }
};

const addRuntimeInstancesForRuntime = (
  subjects: Set<string>,
  loadedReport: LoadedCompileReport,
  runtimeName: string
): void => {
  if (loadedReport.kind !== "loaded") {
    return;
  }

  for (const instance of loadedReport.report.runtimeInstances) {
    if (instance.runtime === runtimeName) {
      subjects.add(`runtime-instance:${instance.id}`);
      instance.nodeIds.forEach((nodeId) => subjects.add(nodeId));
    }
  }
};

const addDeploymentSubjects = (
  subjects: Set<string>,
  deployments: StatusDeploymentSummary[]
): void => {
  for (const deployment of deployments) {
    let deploymentMatches = false;
    for (const unit of deployment.units) {
      const unitMatches = unit.contains.some((entry) => subjects.has(entry.id))
        || unit.runtimeInstances.some((instanceId) => subjects.has(`runtime-instance:${instanceId}`));
      if (!unitMatches) {
        continue;
      }
      deploymentMatches = true;
      subjects.add(`deployment-unit:${deployment.name}:${unit.id}`);
      unit.runtimeInstances.forEach((instanceId) => subjects.add(`runtime-instance:${instanceId}`));
      unit.contains.forEach((entry) => subjects.add(entry.id));
    }
    if (deploymentMatches) {
      subjects.add(`deployment:${deployment.name}`);
    }
  }
};

const addNetworkSubjects = (
  subjects: Set<string>,
  view: OrganizationView,
  loadedReport: LoadedCompileReport,
  networkId: string
): void => {
  const addRoom = (roomId: string, members: string[]): void => {
    subjects.add(`room:${networkId}:${roomId}`);
    members.forEach((member) => subjects.add(`agent:${member}`));
  };

  const declaredNetwork = view.networks.find((network) => network.id === networkId);
  declaredNetwork?.rooms.forEach((room) => addRoom(room.id, room.declaredMembers));
  if (loadedReport.kind !== "loaded") {
    return;
  }

  for (const server of loadedReport.report.moltnetServers ?? []) {
    if (server.networkId === networkId) {
      server.rooms.forEach((room) => addRoom(room.id, room.members));
    }
  }
};

export const expandStatusSelectionSubjects = (
  selection: StatusSelection | null,
  input: {
    deployments: StatusDeploymentSummary[];
    loadedReport: LoadedCompileReport;
    view: OrganizationView;
  }
): StatusSelection | null => {
  if (!selection) {
    return null;
  }

  const subjects = new Set(selection.subjectKeys);
  const nodeIds = new Set(selection.subjectKeys.filter((subject) =>
    subject.startsWith("agent:") || subject.startsWith("team:")
  ));
  if (nodeIds.size > 0) {
    addRuntimeInstancesForNodes(subjects, input.loadedReport, nodeIds);
  }
  if (selection.kind === "runtime") {
    addRuntimeInstancesForRuntime(subjects, input.loadedReport, selection.value);
  }
  if (selection.kind === "network") {
    addNetworkSubjects(subjects, input.view, input.loadedReport, selection.value);
  }
  addDeploymentSubjects(subjects, input.deployments);

  return {
    ...selection,
    subjectKeys: [...subjects]
  };
};
