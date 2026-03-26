import type {
  ResolvedAgentNode,
  ResolvedAgentSurfaces
} from "../../compiler/types.js";
import { listEffectiveExecutionModelTargets } from "../../compiler/modelEnv.js";
import type { AdapterCompileResult, RuntimeAdapter } from "../types.js";
import {
  createAgentCapabilities,
  createDiagnostic,
  createDocumentFiles,
  createSkillFiles
} from "../common.js";
import { SpawnfileError } from "../../shared/index.js";
import { prepareOpenClawRuntimeAuth } from "./runAuth.js";
import { createOpenClawAgentScaffold } from "./scaffold.js";

const buildEnvSecretRef = (envName: string): Record<string, string> => ({
  id: envName,
  provider: "default",
  source: "env"
});

const createCustomProviderId = (provider: "custom" | "local"): string =>
  `spawnfile-${provider}`;

const buildOpenClawDiscordConfig = (
  surfaces: ResolvedAgentSurfaces
): Record<string, unknown> => {
  const discordSurface = surfaces.discord;
  if (!discordSurface) {
    return {};
  }

  const config: Record<string, unknown> = {
    enabled: true
  };
  const access = discordSurface.access;

  if (!access) {
    return config;
  }

  if (access.mode === "pairing") {
    return {
      ...config,
      dmPolicy: "pairing"
    };
  }

  if (access.mode === "open") {
    return {
      ...config,
      allowFrom: ["*"],
      dmPolicy: "open",
      groupPolicy: "open"
    };
  }

  if (access.channels.length > 0 && access.guilds.length !== 1) {
    throw new SpawnfileError(
      "validation_error",
      "OpenClaw Discord channel allowlists require exactly one guild id"
    );
  }

  const guilds =
    access.guilds.length > 0
      ? Object.fromEntries(
          access.guilds.map((guildId) => [
            guildId,
            {
              ...(access.channels.length > 0
                ? {
                    channels: Object.fromEntries(
                      access.channels.map((channelId) => [channelId, { allow: true }])
                    )
                  }
                : {}),
              ...(access.users.length > 0 ? { users: access.users } : {})
            }
          ])
        )
      : undefined;

  return {
    ...config,
    ...(access.users.length > 0 ? { allowFrom: access.users, dmPolicy: "allowlist" } : {}),
    ...(guilds
      ? {
          groupPolicy: "allowlist",
          guilds
        }
      : {
          groupPolicy: "disabled"
        })
  };
};

const createOpenClawModelConfig = (node: ResolvedAgentNode): {
  model: string | null;
  providers?: Record<string, unknown>;
} => {
  const [primary] = listEffectiveExecutionModelTargets(node.execution);
  if (!primary) {
    return { model: null };
  }

  if (primary.provider !== "custom" && primary.provider !== "local") {
    return { model: `${primary.provider}/${primary.name}` };
  }

  const providerId = createCustomProviderId(primary.provider);
  return {
    model: `${providerId}/${primary.name}`,
    providers: {
      [providerId]: {
        api:
          primary.endpoint?.compatibility === "anthropic"
            ? "anthropic-messages"
            : "openai-completions",
        ...(primary.auth.method === "api_key" && primary.auth.key
          ? { apiKey: buildEnvSecretRef(primary.auth.key) }
          : {}),
        baseUrl: primary.endpoint?.base_url,
        models: [
          {
            id: primary.name,
            name: primary.name
          }
        ]
      }
    }
  };
};

const buildOpenClawConfig = (node: ResolvedAgentNode): string => {
  const modelConfig = createOpenClawModelConfig(node);

  const config: Record<string, unknown> = {
    agents: {
      defaults: {
        ...(modelConfig.model ? { model: modelConfig.model } : {}),
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

  if (node.surfaces?.discord) {
    config.channels = {
      discord: buildOpenClawDiscordConfig(node.surfaces)
    };
  }

  if (modelConfig.providers) {
    config.models = {
      providers: modelConfig.providers
    };
  }

  return `${JSON.stringify(config, null, 2)}\n`;
};

const createOpenClawStateFiles = (): Array<{ content: string; path: string }> => [
  {
    // Pre-create the agent state tree so Docker bind mounts do not create root-owned parents.
    content: "",
    path: "home/.openclaw/agents/main/agent/.keep"
  },
  {
    // OpenClaw persists session state under agents/main/sessions at runtime.
    content: "",
    path: "home/.openclaw/agents/main/sessions/.keep"
  }
];

export const openClawAdapter: RuntimeAdapter = {
  assertSupportedModelTarget(target) {
    if (target.endpoint) {
      if (target.auth.method === "claude-code" || target.auth.method === "codex") {
        throw new SpawnfileError(
          "validation_error",
          `OpenClaw custom or local models do not support ${target.auth.method} auth`
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
      `OpenClaw does not support model auth method ${target.auth.method} for provider ${target.provider}`
    );
  },
  assertSupportedSurfaces(surfaces) {
    const access = surfaces?.discord?.access;
    if (!access) {
      return;
    }

    if (access.mode === "allowlist" && access.channels.length > 0 && access.guilds.length !== 1) {
      throw new SpawnfileError(
        "validation_error",
        "OpenClaw Discord channel allowlists require exactly one guild id"
      );
    }
  },
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
        ...createOpenClawStateFiles(),
        {
          content: buildOpenClawConfig(node),
          path: "openclaw.json"
        }
      ]
    };
  },
  name: "openclaw",
  prepareRuntimeAuth: prepareOpenClawRuntimeAuth,
  scaffoldAgentProject: createOpenClawAgentScaffold,
  validateRuntimeOptions(options) {
    if ("profile" in options && typeof options.profile !== "string") {
      return [createDiagnostic("error", "OpenClaw runtime option profile must be a string")];
    }

    return [];
  }
};
