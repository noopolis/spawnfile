import type { ResolvedAgentNode } from "../../compiler/types.js";
import type { AdapterCompileResult, RuntimeAdapter } from "../types.js";
import {
  createAgentCapabilities,
  createDiagnostic,
  createDocumentFiles,
  createSkillFiles
} from "../common.js";

const formatModel = (node: ResolvedAgentNode): string | null => {
  const primary = node.execution?.model?.primary;
  if (!primary) return null;
  return `${primary.provider}/${primary.name}`;
};

const buildOpenClawConfig = (node: ResolvedAgentNode): string => {
  const model = formatModel(node);

  const config: Record<string, unknown> = {
    agents: {
      defaults: {
        ...(model ? { model } : {}),
        workspace: "<workspace-path>"
      }
    },
    gateway: {
      auth: {
        mode: "token"
      },
      bind: "lan",
      controlUi: {
        allowedOrigins: [
          "http://127.0.0.1:<gateway-port>",
          "http://localhost:<gateway-port>"
        ]
      },
      mode: "local",
      port: "<gateway-port>"
    }
  };

  return `${JSON.stringify(config, null, 2)}\n`;
};

export const openClawAdapter: RuntimeAdapter = {
  container: {
    configFileName: "openclaw.json",
    configPathEnv: "OPENCLAW_CONFIG_PATH",
    env: [
      {
        description: "Gateway auth token required for non-loopback OpenClaw access",
        name: "OPENCLAW_GATEWAY_TOKEN",
        required: true
      }
    ],
    homeEnv: "OPENCLAW_HOME",
    instancePaths: {
      configPathTemplate: "<instance-root>/home/.openclaw/<config-file>",
      homePathTemplate: "<instance-root>/home",
      workspacePathTemplate: "<instance-root>/home/.openclaw/workspace"
    },
    port: 18789,
    portEnv: "OPENCLAW_GATEWAY_PORT",
    standaloneBaseImage: "node:24-bookworm-slim",
    startCommand: [
      "node",
      "<runtime-root>/openclaw.mjs",
      "gateway",
      "--allow-unconfigured",
      "--bind",
      "lan",
      "--port",
      "<port>",
      "--verbose"
    ],
    systemDeps: ["bash", "ca-certificates", "curl", "git", "hostname", "openssl", "procps"]
  },
  async compileAgent(node): Promise<AdapterCompileResult> {
    return {
      capabilities: createAgentCapabilities(node, {
        mcpOutcome: node.mcpServers.length > 0 ? "degraded" : "supported",
        subagentOutcome: node.subagents.length > 0 ? "degraded" : "supported"
      }),
      diagnostics: [
        ...(node.subagents.length > 0
          ? [createDiagnostic("warn" as const, "OpenClaw subagents lower to routed sessions in v0.1")]
          : []),
        ...(node.mcpServers.length > 0
          ? [createDiagnostic("warn" as const, "OpenClaw MCP goes through mcporter bridge; direct config may not apply")]
          : [])
      ],
      files: [
        ...createDocumentFiles("workspace", node.docs),
        ...createSkillFiles("workspace/skills", node.skills),
        {
          content: buildOpenClawConfig(node),
          path: "openclaw.json"
        }
      ]
    };
  },
  name: "openclaw",
  validateRuntimeOptions(options) {
    if ("profile" in options && typeof options.profile !== "string") {
      return [createDiagnostic("error", "OpenClaw runtime option profile must be a string")];
    }

    return [];
  }
};
