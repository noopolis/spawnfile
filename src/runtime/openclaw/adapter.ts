import type {
  ResolvedAgentNode,
} from "../../compiler/types.js";
import { listEffectiveExecutionModelTargets } from "../../compiler/modelEnv.js";
import type {
  AdapterCompileResult,
  ContainerTarget,
  ContainerTargetInput,
  RuntimeAdapter
} from "../types.js";
import {
  createAgentCapabilities,
  createDiagnostic,
  createDocumentFiles,
  createSkillFiles
} from "../common.js";
import { SpawnfileError } from "../../shared/index.js";
import { applyOpenClawImportAuthConfig, resolveOpenClawImportAuthModes } from "./configAuth.js";
import { prepareOpenClawRuntimeAuth } from "./runAuth.js";
import { createOpenClawAgentScaffold } from "./scaffold.js";
import {
  assertSupportedOpenClawSurfaces,
  buildOpenClawChannelConfig,
  buildOpenClawSurfaceEnvBindings
} from "./surfaces.js";
import {
  buildOpenClawMoltnetConfig,
  buildOpenClawMoltnetEnvBindings,
  validateOpenClawMoltnetRuntimeOptions
} from "./moltnet.js";
import { openClawStatusProbes } from "./statusProbes.js";

const buildEnvSecretRef = (envName: string): Record<string, string> => ({
  id: envName,
  provider: "default",
  source: "env"
});

const createCustomProviderId = (provider: "custom" | "local"): string =>
  `spawnfile-${provider}`;

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
      bind: "loopback",
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

  if ((node.surfaces?.moltnet?.length ?? 0) > 0) {
    config.hooks = {
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:"],
      enabled: true,
      token: "${OPENCLAW_HOOKS_TOKEN}"
    };
  }

  const channels = buildOpenClawChannelConfig(node.surfaces);
  if (Object.keys(channels).length > 0) {
    config.channels = channels;
  }

  if (modelConfig.providers) {
    config.models = {
      providers: modelConfig.providers
    };
  }

  const moltnet = buildOpenClawMoltnetConfig(node.runtime.options);
  if (moltnet) {
    config.moltnet = moltnet;
  }

  // Bake the import-auth (claude-code/codex) OAuth structure at compile time so
  // the image is self-sufficient; only the credential tokens are injected later.
  const authBaked = applyOpenClawImportAuthConfig(
    config,
    resolveOpenClawImportAuthModes(node)
  );

  return `${JSON.stringify(authBaked, null, 2)}\n`;
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

const createContainerTargets = async (
  inputs: ContainerTargetInput[]
): Promise<ContainerTarget[]> =>
  inputs.map((input) => {
    const agent = input.kind === "agent" ? (input.value as ResolvedAgentNode) : null;
    const configEnvBindings = [
      ...(agent?.surfaces?.moltnet
        ? [
            {
              envName: "OPENCLAW_HOOKS_TOKEN",
              generated: true,
              jsonPath: "hooks.token"
            }
          ]
        : []),
      ...(buildOpenClawSurfaceEnvBindings(agent?.surfaces) ?? []),
      ...(agent ? (buildOpenClawMoltnetEnvBindings(agent.runtime.options) ?? []) : [])
    ];

    return {
      ...(configEnvBindings.length > 0 ? { configEnvBindings } : {}),
      files: input.emittedFiles,
      id: `${input.kind}-${input.slug}`,
      sourceIds: [input.id]
    };
  });

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
    assertSupportedOpenClawSurfaces(surfaces);
  },
  container: {
    configFileName: "openclaw.json",
    configPathEnv: "OPENCLAW_CONFIG_PATH",
    env: [
      {
        description: "Gateway auth token required for non-loopback OpenClaw access",
        generated: true,
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
    portStride: 20,
    portEnv: "OPENCLAW_GATEWAY_PORT",
    standaloneBaseImage: "node:24-bookworm-slim",
    startCommand: [
      "node",
      "<runtime-root>/openclaw.mjs",
      "gateway",
      "--allow-unconfigured",
      "--bind",
      "loopback",
      "--port",
      "<port>",
      "--verbose"
    ],
    systemDeps: ["bash", "ca-certificates", "curl", "git", "hostname", "openssl", "procps"]
  },
  systemInstructionSurface: {
    placement: "append_pointer",
    resolvePath() {
      return "workspace/AGENTS.md";
    }
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
  async createContainerTargets(inputs) {
    return createContainerTargets(inputs);
  },
  name: "openclaw",
  prepareRuntimeAuth: prepareOpenClawRuntimeAuth,
  scaffoldAgentProject: createOpenClawAgentScaffold,
  statusProbes: openClawStatusProbes,
  validateRuntimeOptions(options) {
    const diagnostics = validateOpenClawMoltnetRuntimeOptions(options).map((message) =>
      createDiagnostic("error", message)
    );

    if ("profile" in options && typeof options.profile !== "string") {
      diagnostics.push(
        createDiagnostic("error", "OpenClaw runtime option profile must be a string")
      );
    }

    return diagnostics;
  }
};
