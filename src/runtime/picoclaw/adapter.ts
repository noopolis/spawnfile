import type { ResolvedAgentNode } from "../../compiler/types.js";
import type { McpServer } from "../../manifest/index.js";
import type { AdapterCompileResult, RuntimeAdapter } from "../types.js";
import {
  createAgentCapabilities,
  createDiagnostic,
  createDocumentFiles,
  createSkillFiles
} from "../common.js";

const formatModelName = (node: ResolvedAgentNode): string | null => {
  const primary = node.execution?.model?.primary;
  if (!primary) return null;
  return primary.name;
};

const buildModelList = (node: ResolvedAgentNode): Array<Record<string, unknown>> => {
  const entries: Array<Record<string, unknown>> = [];
  const primary = node.execution?.model?.primary;

  if (primary) {
    entries.push({
      model_name: primary.name,
      model: `${primary.provider}/${primary.name}`,
      api_key: ""
    });
  }

  for (const fallback of node.execution?.model?.fallback ?? []) {
    entries.push({
      model_name: fallback.name,
      model: `${fallback.provider}/${fallback.name}`,
      api_key: ""
    });
  }

  return entries;
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

  const config: Record<string, unknown> = {
    agents: {
      defaults: {
        workspace: "<workspace-path>",
        restrict_to_workspace: restrictToWorkspace,
        ...(modelName ? { model_name: modelName } : {})
      }
    },
    model_list: buildModelList(node)
  };

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

export const picoClawAdapter: RuntimeAdapter = {
  container: {
    configFileName: "config.json",
    configPathEnv: "PICOCLAW_CONFIG",
    homeEnv: "PICOCLAW_HOME",
    instancePaths: {
      configPathTemplate: "<instance-root>/picoclaw/<config-file>",
      homePathTemplate: "<instance-root>/picoclaw",
      workspacePathTemplate: "<instance-root>/picoclaw/workspace"
    },
    port: 18790,
    portEnv: "PICOCLAW_GATEWAY_PORT",
    standaloneBaseImage: "golang:1.25-bookworm",
    startCommand: ["picoclaw", "gateway"],
    staticEnv: {
      PICOCLAW_GATEWAY_HOST: "0.0.0.0"
    },
    systemDeps: ["bash", "ca-certificates", "git"]
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
  name: "picoclaw",
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
