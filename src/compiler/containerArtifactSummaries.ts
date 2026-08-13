import type { DistributionOrganizationSummary } from "../distribution/index.js";
import { SpawnfileError } from "../shared/index.js";

import type { MoltnetArtifacts, MoltnetServerPlan } from "./moltnetArtifacts.js";
import type { MoltnetReleaseIdentity } from "./moltnetBinaries.js";
import type {
  CompiledNodeArtifact,
  GeneratedContainerArtifacts
} from "./containerArtifactsTypes.js";
import type { CompilePlan } from "./types.js";

export const createOrganizationSummary = (
  plan: CompilePlan,
  compiledNodes: CompiledNodeArtifact[]
): DistributionOrganizationSummary => {
  const nodes = compiledNodes.map((node) => ({
    id: node.id ?? `${node.kind}:${node.slug}`,
    kind: node.kind,
    name: node.value.name,
    runtimeName: node.runtimeName,
    source: node.value.source
  }));
  const rootNode =
    nodes.find((node) => node.source === plan.root)
    ?? nodes.find((node) => !plan.edges.some((edge) => edge.to === node.id))
    ?? nodes[0];
  if (!rootNode) {
    throw new SpawnfileError(
      "compile_error",
      `Unable to resolve the root node for ${plan.root}`
    );
  }

  const memberEdges = plan.edges.filter((edge) => edge.kind === "team_member");
  const teamsByAgent = new Map<string, string[]>();
  for (const edge of memberEdges) {
    teamsByAgent.set(edge.to, [...(teamsByAgent.get(edge.to) ?? []), edge.from]);
  }

  const agentNodes = nodes.filter((node) => node.kind === "agent");
  const teamNodes = nodes.filter((node) => node.kind === "team");
  const agentIds = new Set(agentNodes.map((node) => node.id));

  return {
    agents: agentNodes
      .map((node) => ({
        id: node.id,
        name: node.name,
        runtime: node.runtimeName,
        teams: [...(teamsByAgent.get(node.id) ?? [])].sort()
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    project: rootNode.name,
    teams: teamNodes
      .map((node) => ({
        agents: memberEdges
          .filter((edge) => edge.from === node.id && agentIds.has(edge.to))
          .map((edge) => edge.to)
          .sort(),
        id: node.id,
        name: node.name
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  };
};

const resolveMoltnetOperatorCredential = (
  plan: MoltnetServerPlan
): { agentId?: string; id?: string; secret?: string } => {
  const client = plan.server.auth.client;
  if (!client) {
    return {};
  }

  if (client.token_env) {
    return { secret: client.token_env };
  }

  if (client.token_path) {
    return { secret: client.token_path };
  }

  if (!client.token_id) {
    return {};
  }

  const token = plan.server.auth.tokens?.find((candidate) => candidate.id === client.token_id);
  const agents = [...new Set((token?.agents ?? []).map((agent) => agent.trim()))].filter(Boolean);
  return {
    ...(agents.length === 1 ? { agentId: agents[0] } : {}),
    id: client.token_id,
    ...(token?.secret ? { secret: token.secret } : {})
  };
};

export const createMoltnetSummary = (
  moltnet: MoltnetArtifacts | undefined | null,
  release: MoltnetReleaseIdentity | undefined
): GeneratedContainerArtifacts["report"]["moltnet"] | undefined => {
  if (!moltnet) {
    return undefined;
  }

  return {
    node_plans: moltnet.nodePlans.map((plan) => ({
      config_path: plan.configPath,
      ...(plan.credentialAgentId ? { credential_agent_id: plan.credentialAgentId } : {}),
      ...(plan.credentialId ? { credential_id: plan.credentialId } : {}),
      ...(plan.credentialSecret ? { credential_secret: plan.credentialSecret } : {}),
      ...(plan.memberId ? { member_id: plan.memberId } : {}),
      network_id: plan.networkId
    })),
    release,
    server_plans: moltnet.serverPlans.map((plan) => {
      const operatorCredential = resolveMoltnetOperatorCredential(plan);

      return {
        ...(plan.server.auth.agent_registration
          ? { agent_registration: plan.server.auth.agent_registration }
          : {}),
        auth_mode: plan.server.auth.mode,
        ...(plan.server.mode === "managed" && plan.server.auth.tokens
          ? {
              auth_tokens: plan.server.auth.tokens.map((token) => ({
                agents: [...new Set((token.agents ?? []).map((agent) => agent.trim()))]
                  .filter(Boolean)
                  .sort(),
                id: token.id,
                scopes: [...token.scopes].sort(),
                secret: token.secret
              }))
            }
          : {}),
        base_url: plan.baseUrl,
        ...(plan.configPath ? { config_path: plan.configPath } : {}),
        ...(plan.server.mode === "managed"
          ? {
              debug_events: plan.server.debug_events,
              direct_messages: plan.server.direct_messages,
              human_ingress: plan.server.human_ingress,
              trust_forwarded_proto: plan.server.trust_forwarded_proto
            }
          : {}),
        id: plan.id,
        mode: plan.mode,
        network_id: plan.networkId,
        network_name: plan.name,
        ...(operatorCredential.agentId
          ? { operator_agent_id: operatorCredential.agentId }
          : {}),
        ...(operatorCredential.id ? { operator_token_id: operatorCredential.id } : {}),
        ...(operatorCredential.secret
          ? { operator_token_secret: operatorCredential.secret }
          : {}),
        ...(plan.port ? { port: plan.port } : {}),
        ...(plan.server.auth.public_read !== undefined
          ? { public_read: plan.server.auth.public_read }
          : {}),
        rooms: plan.rooms.map((room) => ({
          id: room.id,
          members: [...room.members],
          ...(room.visibility ? { visibility: room.visibility } : {}),
          ...(room.write_policy ? { write_policy: room.write_policy } : {})
        })),
        ...(plan.server.mode === "managed"
          ? { store_kind: plan.server.store.kind }
          : {})
      };
    })
  };
};
