import type { ResolvedAgentNode, ResolvedTeamNode } from "../../compiler/types.js";
import type {
  AdapterCompileResult,
  ContainerTarget,
  ContainerTargetInput,
  RuntimeAdapter
} from "../types.js";
import {
  createCapability,
  createAgentCapabilities,
  createDocumentFiles,
  createSkillFiles
} from "../common.js";

const WORKSPACE_PLACEHOLDER = "<workspace-path>";

const buildTinyClawSettings = (node: ResolvedAgentNode): string => {
  const agentEntry: Record<string, unknown> = {
    name: node.name,
    provider: node.execution?.model?.primary?.provider ?? "anthropic",
    model: node.execution?.model?.primary?.name ?? "opus",
    working_directory: `${WORKSPACE_PLACEHOLDER}/${node.name}`
  };

  const config: Record<string, unknown> = {
    workspace: {
      path: WORKSPACE_PLACEHOLDER,
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

const parseJsonFile = (
  input: ContainerTargetInput,
  filePath: string
): Record<string, unknown> => {
  const file = input.emittedFiles.find((entry) => entry.path === filePath);
  if (!file) {
    throw new Error(`TinyClaw target ${input.id} is missing ${filePath}`);
  }

  return JSON.parse(file.content) as Record<string, unknown>;
};

const mergeTinyClawTargets = async (
  inputs: ContainerTargetInput[]
): Promise<ContainerTarget[]> => {
  const agentInputs = inputs.filter((input) => input.kind === "agent");
  if (agentInputs.length === 0) {
    return [];
  }

  const mergedAgents: Record<string, unknown> = {};
  const mergedTeams: Record<string, unknown> = {};
  const workspaceFiles = agentInputs.flatMap((input) =>
    input.emittedFiles.filter((file) => file.path !== "settings.json")
  );

  let mergedBase: Record<string, unknown> | null = null;

  for (const input of agentInputs) {
    const settings = parseJsonFile(input, "settings.json");
    mergedBase ??= settings;
    Object.assign(
      mergedAgents,
      (settings.agents as Record<string, unknown> | undefined) ?? {}
    );
  }

  for (const input of inputs.filter((entry) => entry.kind === "team")) {
    if (!input.emittedFiles.some((file) => file.path === "tinyclaw-team.json")) {
      continue;
    }

    const teamConfig = parseJsonFile(input, "tinyclaw-team.json");
    Object.assign(
      mergedTeams,
      (teamConfig.teams as Record<string, unknown> | undefined) ?? {}
    );
  }

  const mergedSettings = {
    ...(mergedBase ?? {}),
    agents: mergedAgents,
    ...(Object.keys(mergedTeams).length > 0 ? { teams: mergedTeams } : {}),
    workspace: {
      ...(((mergedBase?.workspace as Record<string, unknown> | undefined) ?? {})),
      name: ((mergedBase?.workspace as Record<string, unknown> | undefined)?.name as string | undefined) ?? "workspace",
      path: WORKSPACE_PLACEHOLDER
    }
  };

  return [
    {
      files: [
        ...workspaceFiles,
        {
          content: `${JSON.stringify(mergedSettings, null, 2)}\n`,
          path: "settings.json"
        }
      ],
      id: "tinyclaw-runtime"
    }
  ];
};

export const tinyClawAdapter: RuntimeAdapter = {
  container: {
    configFileName: "settings.json",
    homeEnv: "TINYAGI_HOME",
    instancePaths: {
      configPathTemplate: "<instance-root>/tinyagi/<config-file>",
      homePathTemplate: "<instance-root>/tinyagi",
      workspacePathTemplate: "<instance-root>/workspace"
    },
    port: 3777,
    portEnv: "TINYAGI_API_PORT",
    standaloneBaseImage: "node:22-bookworm-slim",
    startCommand: ["node", "<runtime-root>/packages/main/dist/index.js"],
    systemDeps: ["bash", "ca-certificates", "curl", "g++", "make", "python3", "tar"]
  },
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
  async createContainerTargets(inputs): Promise<ContainerTarget[]> {
    return mergeTinyClawTargets(inputs);
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
