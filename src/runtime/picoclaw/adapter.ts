import type {
  ResolvedAgentNode,
  ResolvedAgentSurfaces
} from "../../compiler/types.js";
import {
  listEffectiveExecutionModelTargets,
  listExecutionModelSecretNames,
  resolveModelProviderEnvName
} from "../../compiler/modelEnv.js";
import type { McpServer } from "../../manifest/index.js";
import type {
  AdapterCompileResult,
  ContainerTarget,
  ContainerTargetInput,
  RuntimeAdapter
} from "../types.js";
import { SpawnfileError } from "../../shared/index.js";
import {
  createAgentCapabilities,
  createDiagnostic,
  createDocumentFiles,
  createSkillFiles
} from "../common.js";
import { preparePicoClawRuntimeAuth } from "./runAuth.js";
import { createPicoClawAgentScaffold } from "./scaffold.js";

const formatModelName = (node: ResolvedAgentNode): string | null => {
  const primary = node.execution?.model?.primary;
  if (!primary) return null;
  return primary.name;
};

const resolveDefaultTemperature = (node: ResolvedAgentNode): number | null => {
  const primary = node.execution?.model?.primary;
  if (!primary) return null;

  if (primary.provider === "openai" && primary.name === "gpt-5") {
    return 1;
  }

  return null;
};

const MODEL_PROVIDER_ENV_VARS = new Map<string, string>([
  ["anthropic", "ANTHROPIC_API_KEY"],
  ["google", "GOOGLE_API_KEY"],
  ["groq", "GROQ_API_KEY"],
  ["mistral", "MISTRAL_API_KEY"],
  ["openai", "OPENAI_API_KEY"],
  ["openrouter", "OPENROUTER_API_KEY"],
  ["xai", "XAI_API_KEY"]
]);

const formatProviderEnvName = (provider: string): string =>
  MODEL_PROVIDER_ENV_VARS.get(provider) ??
  `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;

const createProviderSecretPath = (provider: string): string =>
  createSecretPath(formatProviderEnvName(provider));

const createSecretPath = (envName: string): string => `secrets/${envName}`;

const buildPicoClawDiscordConfig = (
  surfaces: ResolvedAgentSurfaces
): Record<string, unknown> => {
  const access = surfaces.discord?.access;

  return {
    ...(access?.mode === "allowlist" ? { allow_from: access.users } : {}),
    enabled: true,
    mention_only: true
  };
};

const buildModelList = (node: ResolvedAgentNode): Array<Record<string, unknown>> => {
  return listEffectiveExecutionModelTargets(node.execution).map((target) => {
    if (target.endpoint) {
      return {
        ...(target.auth.method === "api_key"
          ? { api_key: `file://${createSecretPath(target.auth.key!)}` }
          : {}),
        api_base: target.endpoint.base_url,
        model:
          target.endpoint.compatibility === "anthropic"
            ? `anthropic-messages/${target.name}`
            : `openai/${target.name}`,
        model_name: target.name
      };
    }

    return {
      ...(target.auth.method === "api_key"
        ? {
            api_key: `file://${createSecretPath(
              target.auth.key ?? resolveModelProviderEnvName(target.provider)
            )}`
          }
        : {}),
      model: `${target.provider}/${target.name}`,
      model_name: target.name
    };
  });
};

const buildMcpServers = (
  servers: McpServer[]
): Record<string, Record<string, unknown>> => {
  const result: Record<string, Record<string, unknown>> = {};

  for (const server of servers) {
    const entry: Record<string, unknown> = { enabled: true };

    if (server.transport === "stdio") {
      entry.command = server.command;
      if (server.args) entry.args = server.args;
      if (server.env) entry.env = server.env;
    } else {
      entry.type = server.transport === "streamable_http" ? "http" : server.transport;
      entry.url = server.url;
    }

    if (server.auth) {
      entry.headers = { [server.auth.secret]: "" };
    }

    result[server.name] = entry;
  }

  return result;
};

const buildPicoClawConfig = (node: ResolvedAgentNode): string => {
  const modelName = formatModelName(node);
  const restrictToWorkspace = node.runtime.options.restrict_to_workspace ?? true;
  const temperature = resolveDefaultTemperature(node);

  const config: Record<string, unknown> = {
    agents: {
      defaults: {
        workspace: "<workspace-path>",
        restrict_to_workspace: restrictToWorkspace,
        ...(modelName ? { model_name: modelName } : {}),
        ...(temperature !== null ? { temperature } : {})
      }
    },
    model_list: buildModelList(node)
  };

  if (node.surfaces?.discord) {
    config.channels = {
      discord: buildPicoClawDiscordConfig(node.surfaces)
    };
  }

  if (node.mcpServers.length > 0) {
    config.tools = {
      mcp: {
        enabled: true,
        servers: buildMcpServers(node.mcpServers)
      }
    };
  }

  return `${JSON.stringify(config, null, 2)}\n`;
};

const createContainerTargets = async (
  inputs: ContainerTargetInput[]
): Promise<ContainerTarget[]> =>
  inputs.map((input) => {
    const agent = input.value as ResolvedAgentNode;
    const envFiles = listExecutionModelSecretNames(agent.execution).map((secretName) => ({
      envName: secretName,
      relativePath: createSecretPath(secretName)
    }));
    const configEnvBindings = agent.surfaces?.discord
      ? [
          {
            envName: agent.surfaces.discord.botTokenSecret,
            jsonPath: "channels.discord.token"
          }
        ]
      : undefined;

    return {
      configEnvBindings,
      envFiles,
      files: input.emittedFiles,
      id: `${input.kind}-${input.slug}`,
      sourceIds: [input.id]
    };
  });

export const picoClawAdapter: RuntimeAdapter = {
  assertSupportedModelTarget(target) {
    if (target.endpoint) {
      if (
        target.endpoint.compatibility === "anthropic" &&
        target.auth.method === "none"
      ) {
        throw new SpawnfileError(
          "validation_error",
          "PicoClaw anthropic-compatible custom or local models require api_key auth"
        );
      }

      if (target.auth.method === "claude-code" || target.auth.method === "codex") {
        throw new SpawnfileError(
          "validation_error",
          `PicoClaw custom or local models do not support ${target.auth.method} auth`
        );
      }

      return;
    }

    if (target.provider === "anthropic") {
      if (target.auth.method === "api_key" || target.auth.method === "claude-code") {
        return;
      }
    } else if (target.provider === "openai") {
      if (target.auth.method === "api_key" || target.auth.method === "codex") {
        return;
      }
    } else if (target.auth.method === "api_key" || target.auth.method === "none") {
      return;
    }

    throw new SpawnfileError(
      "validation_error",
      `PicoClaw does not support model auth method ${target.auth.method} for provider ${target.provider}`
    );
  },
  assertSupportedSurfaces(surfaces) {
    const access = surfaces?.discord?.access;
    if (!access) {
      return;
    }

    if (access.mode === "pairing") {
      throw new SpawnfileError(
        "validation_error",
        "PicoClaw Discord does not support pairing access"
      );
    }

    if (access.guilds.length > 0 || access.channels.length > 0) {
      throw new SpawnfileError(
        "validation_error",
        "PicoClaw Discord only supports user allowlists in Spawnfile v0.1"
      );
    }
  },
  container: {
    configFileName: "config.json",
    configPathEnv: "PICOCLAW_CONFIG",
    globalNpmPackages: ["@anthropic-ai/claude-code", "@openai/codex"],
    homeEnv: "PICOCLAW_HOME",
    instancePaths: {
      configPathTemplate: "<instance-root>/picoclaw/<config-file>",
      homePathTemplate: "<instance-root>/picoclaw",
      workspacePathTemplate: "<instance-root>/picoclaw/workspace"
    },
    port: 18790,
    portEnv: "PICOCLAW_GATEWAY_PORT",
    standaloneBaseImage: "debian:bookworm-slim",
    startCommand: ["picoclaw", "gateway", "--allow-empty"],
    staticEnv: {
      PICOCLAW_GATEWAY_HOST: "0.0.0.0"
    },
    systemDeps: ["bash", "ca-certificates", "curl", "nodejs", "npm", "tar"]
  },
  async compileAgent(node): Promise<AdapterCompileResult> {
    return {
      capabilities: createAgentCapabilities(node),
      diagnostics: [],
      files: [
        ...createDocumentFiles("workspace", node.docs),
        ...createSkillFiles("workspace/skills", node.skills),
        {
          content: buildPicoClawConfig(node),
          path: "config.json"
        }
      ]
    };
  },
  async createContainerTargets(inputs): Promise<ContainerTarget[]> {
    return createContainerTargets(inputs);
  },
  name: "picoclaw",
  prepareRuntimeAuth: preparePicoClawRuntimeAuth,
  scaffoldAgentProject: createPicoClawAgentScaffold,
  validateRuntimeOptions(options) {
    if (
      "restrict_to_workspace" in options &&
      typeof options.restrict_to_workspace !== "boolean"
    ) {
      return [
        createDiagnostic(
          "error",
          "PicoClaw runtime option restrict_to_workspace must be a boolean"
        )
      ];
    }

    return [];
  }
};
