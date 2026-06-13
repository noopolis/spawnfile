import type {
  OrganizationNetworkView,
  OrganizationRuntimeView,
  OrganizationView,
  OrganizationViewTreeEdge,
  OrganizationViewTreeNode
} from "../compiler/index.js";

import type { DistributionReport } from "./types.js";

const IMAGE_SOURCE_PLACEHOLDER = "<image>";

const buildAgentNode = (
  agent: DistributionReport["organization"]["agents"][number]
): OrganizationViewTreeNode => ({
  children: [],
  displayName: agent.name,
  id: agent.id,
  kind: "agent",
  name: agent.name,
  runtimeName: agent.runtime,
  source: IMAGE_SOURCE_PLACEHOLDER
});

/**
 * Projects a distribution report into an OrganizationView so sourceless image
 * status can reuse the existing renderer. There is no source, so the declared
 * layer is intentionally sparse; node sources use an image placeholder.
 */
export const projectImageOrganizationView = (
  report: DistributionReport,
  inputPath: string
): OrganizationView => {
  const agentsById = new Map(report.organization.agents.map((agent) => [agent.id, agent]));
  const teams = report.organization.teams;

  const networks: OrganizationNetworkView[] = report.moltnet.networks.map((network) => ({
    declaringTeamName: report.organization.project,
    declaringTeamSource: IMAGE_SOURCE_PLACEHOLDER,
    id: network.id,
    name: network.id,
    provider: "moltnet",
    rooms: [],
    serverMode: network.server_mode
  }));

  const runtimes: OrganizationRuntimeView[] = [
    ...new Map(
      report.runtime_instances.map((instance) => [
        instance.runtime,
        {
          name: instance.runtime,
          nodeIds: report.runtime_instances
            .filter((other) => other.runtime === instance.runtime)
            .flatMap((other) => other.node_ids)
            .sort()
        }
      ])
    ).values()
  ].sort((left, right) => left.name.localeCompare(right.name));

  let root: OrganizationViewTreeNode;
  if (teams.length > 0) {
    const rootTeam = teams[0]!;
    const memberEdges: OrganizationViewTreeEdge[] = rootTeam.agents
      .map((agentId) => agentsById.get(agentId))
      .filter((agent): agent is DistributionReport["organization"]["agents"][number] =>
        agent !== undefined
      )
      .map((agent) => ({
        label: agent.id,
        node: buildAgentNode(agent),
        relation: "team_member" as const
      }));
    root = {
      children: memberEdges,
      displayName: rootTeam.name,
      id: rootTeam.id,
      kind: "team",
      name: rootTeam.name,
      runtimeName: null,
      source: IMAGE_SOURCE_PLACEHOLDER
    };
  } else if (report.organization.agents.length > 0) {
    root = buildAgentNode(report.organization.agents[0]!);
  } else {
    root = {
      children: [],
      displayName: report.organization.project,
      id: report.organization.project,
      kind: "team",
      name: report.organization.project,
      runtimeName: null,
      source: IMAGE_SOURCE_PLACEHOLDER
    };
  }

  return {
    contexts: [],
    diagnostics: [],
    inputPath,
    networks,
    root,
    runtimes
  };
};
