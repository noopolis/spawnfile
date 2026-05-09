import { SpawnfileError } from "../shared/index.js";

import { stableStringify } from "./helpers.js";
import type {
  CompilePlanNode,
  ResolvedAgentNode,
  ResolvedSkill,
  ResolvedTeamNode
} from "./types.js";

import type { TeamNetworkServer } from "../manifest/index.js";

export const getMcpNames = (servers: Array<{ name: string }>): Set<string> =>
  new Set(servers.map((server) => server.name));

export const validateEffectiveSkillRequirements = (
  nodeName: string,
  mcpNames: Set<string>,
  skills: ResolvedSkill[]
): void => {
  for (const skill of skills) {
    for (const mcpName of skill.requiresMcp) {
      if (!mcpNames.has(mcpName)) {
        throw new SpawnfileError(
          "validation_error",
          `Skill ${skill.name} on ${nodeName} requires undeclared MCP server: ${mcpName}`
        );
      }
    }
  }
};

export const getAgentFingerprint = (node: ResolvedAgentNode): string =>
  stableStringify({
    env: node.env,
    execution: node.execution,
    mcpServers: node.mcpServers,
    runtime: node.runtime,
    schedule: node.schedule,
    secrets: node.secrets,
    skills: node.skills.map((skill) => ({
      name: skill.name,
      ref: skill.ref,
      requiresMcp: skill.requiresMcp
    })),
    surfaces: node.surfaces,
    workspaceResources: node.workspaceResources
  });

export const getTeamFingerprint = (node: ResolvedTeamNode): string =>
  stableStringify({
    members: node.members,
    mode: node.mode,
    lead: node.lead,
    external: node.external,
    networks: node.networks ?? [],
    workspaceResources: node.workspaceResources,
    shared: {
      env: node.shared.env,
      mcpServers: node.shared.mcpServers,
      secrets: node.shared.secrets,
      skills: node.shared.skills.map((skill) => ({
        name: skill.name,
        ref: skill.ref,
        requiresMcp: skill.requiresMcp
      }))
    }
  });

const collectMoltnetSecretNames = (
  server: TeamNetworkServer,
  secretNames: Set<string>
): void => {
  for (const token of server.auth.tokens ?? []) {
    secretNames.add(token.secret);
  }

  if (server.mode === "managed") {
    for (const pairing of server.pairings ?? []) {
      secretNames.add(pairing.token_secret);
    }

    if (server.store.kind === "postgres") {
      secretNames.add(server.store.dsn_secret);
    }
  }

  if (server.auth.client?.token_env) {
    secretNames.add(server.auth.client.token_env);
  }
};

export const listMoltnetNetworkSecretNames = (
  nodes: CompilePlanNode[]
): string[] => {
  const secretNames = new Set<string>();

  for (const node of nodes) {
    if (node.value.kind !== "team" || !node.value.networks) {
      continue;
    }

    for (const network of node.value.networks) {
      if (network.server) {
        collectMoltnetSecretNames(network.server, secretNames);
      }
    }
  }

  return [...secretNames].sort();
};
