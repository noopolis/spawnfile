import type { ResolvedAgentNode, ResolvedTeamNode } from "../../compiler/types.js";
import type { AdapterCompileResult, RuntimeAdapter } from "../types.js";
import {
  createCapability,
  createAgentCapabilities,
  createDocumentFiles,
  createSkillFiles
} from "../common.js";

const buildTinyClawSettings = (node: ResolvedAgentNode): string => {
  const agentEntry: Record<string, unknown> = {
    name: node.name,
    provider: node.execution?.model?.primary?.provider ?? "anthropic",
    model: node.execution?.model?.primary?.name ?? "opus",
    working_directory: `<workspace-path>/${node.name}`
  };

  const config: Record<string, unknown> = {
    workspace: {
      path: "<workspace-path>",
      name: "workspace"
    },
    channels: {
      enabled: []
    },
    agents: {
      [node.name]: agentEntry
    },
    models: {
      provider: node.execution?.model?.primary?.provider ?? "anthropic"
    },
    monitoring: {
      heartbeat_interval: 3600
    }
  };

  return `${JSON.stringify(config, null, 2)}\n`;
};

export const tinyClawAdapter: RuntimeAdapter = {
  async compileAgent(node): Promise<AdapterCompileResult> {
    return {
      capabilities: createAgentCapabilities(node, {
        mcpOutcome: node.mcpServers.length > 0 ? "degraded" : "supported"
      }),
      diagnostics: [],
      files: [
        ...createDocumentFiles(`workspace/${node.name}`, node.docs),
        ...createSkillFiles(`workspace/${node.name}/.agents/skills`, node.skills),
        ...createSkillFiles(`workspace/${node.name}/.claude/skills`, node.skills),
        {
          content: buildTinyClawSettings(node),
          path: "settings.json"
        }
      ]
    };
  },
  async compileTeam(node: ResolvedTeamNode): Promise<AdapterCompileResult> {
    const agentIds = node.members
      .filter((member) => member.kind === "agent")
      .map((member) => member.id);

    const teamConfig = {
      name: node.name,
      agents: agentIds,
      leader_agent: node.structure.leader ?? agentIds[0] ?? "leader"
    };

    return {
      capabilities: [
        createCapability("team.members", "supported"),
        createCapability("team.structure.mode", node.structure.mode === "hierarchical" ? "supported" : "degraded", "TinyClaw only supports leader-led teams"),
        createCapability("team.structure.leader", node.structure.leader ? "supported" : "degraded", "TinyClaw requires a leader_agent"),
        createCapability("team.structure.external", "degraded", "TinyClaw does not enforce external boundary"),
        createCapability("team.shared", "supported"),
        createCapability("team.nested", "degraded", "TinyClaw nested teams flatten in v0.1")
      ],
      diagnostics: [],
      files: [
        {
          content: `${JSON.stringify({ teams: { [node.name]: teamConfig } }, null, 2)}\n`,
          path: "tinyclaw-team.json"
        }
      ]
    };
  },
  name: "tinyclaw"
};
