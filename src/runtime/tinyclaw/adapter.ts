import type { ResolvedAgentNode, ResolvedTeamNode } from "../../compiler/types.js";
import { listEffectiveExecutionModelTargets } from "../../compiler/modelEnv.js";
import type {
  AdapterCompileResult,
  ContainerTarget,
  ContainerTargetInput,
  RuntimeAdapter
} from "../types.js";
import { SpawnfileError } from "../../shared/index.js";
import {
  createCapability,
  createAgentCapabilities,
  createDocumentFiles,
  createSkillFiles
} from "../common.js";
import { prepareTinyClawRuntimeAuth } from "./runAuth.js";
import { createTinyClawAgentScaffold } from "./scaffold.js";

const WORKSPACE_PLACEHOLDER = "<workspace-path>";

const buildTinyClawSettings = (node: ResolvedAgentNode): string => {
  const [primary] = listEffectiveExecutionModelTargets(node.execution);
  const agentEntry: Record<string, unknown> = {
    name: node.name,
    provider: primary?.provider ?? "anthropic",
    model: primary?.name ?? "opus",
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
      provider: primary?.provider ?? "anthropic"
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
      id: "tinyclaw-runtime",
      sourceIds: agentInputs.map((input) => input.id)
    }
  ];
};

export const tinyClawAdapter: RuntimeAdapter = {
  assertSupportedModelTarget(target) {
    if (target.endpoint) {
      throw new SpawnfileError(
        "validation_error",
        "TinyClaw custom or local endpoints are not supported in Spawnfile v0.1"
      );
    }

    if (target.provider === "anthropic") {
      if (target.auth.method === "claude-code") {
        return;
      }
    } else if (target.provider === "openai") {
      if (target.auth.method === "codex") {
        return;
      }
    } else if (target.provider === "opencode" && target.auth.method === "none") {
      return;
    }

    throw new SpawnfileError(
      "validation_error",
      `TinyClaw does not support model auth method ${target.auth.method} for provider ${target.provider}`
    );
  },
  container: {
    configFileName: "settings.json",
    configEnvBindings: [
      {
        envName: "ANTHROPIC_API_KEY",
        jsonPath: "models.anthropic.auth_token"
      },
      {
        envName: "OPENAI_API_KEY",
        jsonPath: "models.openai.auth_token"
      }
    ],
    homeEnv: "TINYAGI_HOME",
    globalNpmPackages: ["@anthropic-ai/claude-code", "@openai/codex"],
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
  name: "tinyclaw",
  prepareRuntimeAuth: prepareTinyClawRuntimeAuth,
  scaffoldAgentProject: createTinyClawAgentScaffold
};
