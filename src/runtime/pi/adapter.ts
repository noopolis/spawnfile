import path from "node:path";

import {
  listEffectiveExecutionModelTargets,
  listExecutionModelSecretNames
} from "../../compiler/modelEnv.js";
import type { ResolvedAgentNode, ResolvedAgentSurfaces } from "../../compiler/types.js";
import { SpawnfileError } from "../../shared/index.js";
import {
  createAgentCapabilities,
  createDiagnostic,
  createDocumentFiles,
  createSkillFiles
} from "../common.js";
import type {
  AdapterCompileResult,
  ContainerTarget,
  ContainerTargetInput,
  EmittedFile,
  RuntimeAdapter
} from "../types.js";

import {
  createPiAgentConfig,
  PI_ENGINE_KINDS,
  PI_PACKAGE_NAME,
  PI_PACKAGE_VERSION,
  renderPiApp,
  renderPiAppConfig,
  renderPiModelsConfig,
  renderPiPackageJson
} from "./appTemplate.js";
import { preparePiRuntimeAuth } from "./runAuth.js";

const PI_CONFIG_FILE = "pi-app.json";
const PI_CONTROL_PORT = 19690;
const PI_MODELS_FILE = "home/.pi/agent/models.json";

const moveWorkspaceFileToAgentWorkspace = (
  file: EmittedFile,
  agentSlug: string
): EmittedFile => {
  if (!file.path.startsWith("workspace/")) {
    return file;
  }

  const relativePath = file.path.slice("workspace/".length);
  return {
    ...file,
    path: path.posix.join("workspace", "agents", agentSlug, relativePath)
  };
};

const createContainerTargets = async (
  inputs: ContainerTargetInput[]
): Promise<ContainerTarget[]> => {
  const agentInputs = inputs.filter(
    (input): input is ContainerTargetInput & { value: ResolvedAgentNode } =>
      input.kind === "agent" && input.value.kind === "agent"
  );

  if (agentInputs.length === 0) {
    return [];
  }

  const agents = agentInputs.map((input) =>
    createPiAgentConfig(input.value, input.slug, input.id)
  );
  const envFiles = [
    ...new Set(
      agentInputs.flatMap((input) =>
        listExecutionModelSecretNames(input.value.execution)
      )
    )
  ].map((secretName) => ({
    envName: secretName,
    relativePath: `secrets/${secretName}`
  }));

  return [
    {
      envFiles,
      files: [
        ...agentInputs.flatMap((input) =>
          input.emittedFiles.map((file) =>
            moveWorkspaceFileToAgentWorkspace(file, input.slug)
          )
        ),
        {
          content: renderPiAppConfig(agents),
          path: PI_CONFIG_FILE
        },
        {
          content: renderPiModelsConfig(agentInputs.map((input) => input.value)),
          path: PI_MODELS_FILE
        },
        {
          content: renderPiPackageJson(),
          path: "runtime/package.json"
        },
        {
          content: renderPiApp(),
          mode: 0o755,
          path: "runtime/app.mjs"
        }
      ],
      id: "pi-app",
      sourceIds: agentInputs.map((input) => input.id).sort()
    }
  ];
};

const scheduleOutcomeFor = (
  node: ResolvedAgentNode
): {
  message?: string;
  outcome?: "degraded" | "supported";
} => {
  if (!node.schedule) {
    return {};
  }

  if (node.schedule.kind === "every" || node.schedule.kind === "disabled") {
    return {
      message: "Pi generated runtime app owns this schedule",
      outcome: "supported"
    };
  }

  return {
    message: "Pi generated runtime app supports every schedules in Spawnfile v0.1",
    outcome: "degraded"
  };
};

const createScheduleDiagnostics = (node: ResolvedAgentNode) =>
  node.schedule?.kind === "cron"
    ? [
        createDiagnostic(
          "warn",
          "Pi generated runtime app supports every schedules in Spawnfile v0.1; cron schedules are degraded"
        )
      ]
    : [];

const moltnetCapabilityOptions = (node: ResolvedAgentNode) =>
  node.surfaces?.moltnet
    ? {
        moltnetMessage:
          "Pi generated runtime app exposes a control endpoint for Moltnet bridge wake delivery",
        moltnetOutcome: "supported" as const
      }
    : {};

const assertSupportedPiSurfaces = (surfaces: ResolvedAgentSurfaces | undefined): void => {
  if (!surfaces) {
    return;
  }

  const unsupported = [
    surfaces.discord ? "discord" : null,
    surfaces.http ? "http" : null,
    surfaces.slack ? "slack" : null,
    surfaces.telegram ? "telegram" : null,
    surfaces.webhook ? "webhook" : null,
    surfaces.whatsapp ? "whatsapp" : null
  ].filter((surface): surface is string => surface !== null);

  if (unsupported.length > 0) {
    throw new SpawnfileError(
      "validation_error",
      `Pi runtime only supports Moltnet surfaces in Spawnfile v0.1; unsupported surfaces: ${unsupported.join(", ")}`
    );
  }
};

export const piAdapter: RuntimeAdapter = {
  assertSupportedModelTarget(target) {
    if (target.endpoint) {
      if (target.provider !== "custom" && target.provider !== "local") {
        throw new SpawnfileError(
          "validation_error",
          "Pi runtime only supports endpoints on custom or local model providers"
        );
      }

      if (target.auth.method === "none" || target.auth.method === "api_key") {
        return;
      }

      throw new SpawnfileError(
        "validation_error",
        `Pi runtime endpoint models only support none or api_key auth, got ${target.auth.method}`
      );
    }

    if (target.provider === "openai") {
      if (target.auth.method === "api_key" || target.auth.method === "codex") {
        return;
      }
    }

    if (target.provider === "anthropic" && target.auth.method === "api_key") {
      return;
    }

    if (target.provider === "anthropic" && target.auth.method === "claude-code") {
      return;
    }

    throw new SpawnfileError(
      "validation_error",
      `Pi runtime does not support model auth method ${target.auth.method} for provider ${target.provider}`
    );
  },
  assertSupportedSurfaces(surfaces) {
    assertSupportedPiSurfaces(surfaces);
  },
  container: {
    configFileName: PI_CONFIG_FILE,
    configPathEnv: "SPAWNFILE_PI_CONFIG",
    homeEnv: "SPAWNFILE_PI_HOME",
    instancePaths: {
      configPathTemplate: "<instance-root>/pi/<config-file>",
      homePathTemplate: "<instance-root>/home",
      sourceWorkspacePathTemplate: "<instance-root>/workspace/agents/<source-slug>",
      workspacePathTemplate: "<instance-root>/workspace"
    },
    port: PI_CONTROL_PORT,
    portEnv: "SPAWNFILE_PI_CONTROL_PORT",
    globalNpmPackages: ["@openai/codex@0.142.3"],
    postRootfsCommands: [
      "curl -fsSL https://x.ai/cli/install.sh | GROK_BIN_DIR=/usr/local/bin bash",
      "if [ -L /usr/local/bin/grok ]; then cp -L /usr/local/bin/grok /usr/local/bin/grok.real && mv /usr/local/bin/grok.real /usr/local/bin/grok && chmod 0755 /usr/local/bin/grok && ln -sf /usr/local/bin/grok /usr/local/bin/agent; fi",
      "curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin"
    ],
    standaloneBaseImage: "node:24-bookworm-slim",
    startCommand: ["node", "<runtime-root>/app.mjs", "<config-path>"],
    systemDeps: ["bash", "ca-certificates", "curl", "git", "procps", "tar"]
  },
  systemInstructionSurface: {
    placement: "append_pointer",
    resolvePath() {
      return "workspace/AGENTS.md";
    }
  },
  async compileAgent(node): Promise<AdapterCompileResult> {
    const scheduleOutcome = scheduleOutcomeFor(node);
    return {
      capabilities: createAgentCapabilities(node, {
        ...moltnetCapabilityOptions(node),
        mcpOutcome: node.mcpServers.length > 0 ? "degraded" : "supported",
        sandboxOutcome: node.execution?.sandbox ? "degraded" : "supported",
        scheduleMessage: scheduleOutcome.message,
        scheduleOutcome: scheduleOutcome.outcome,
        subagentOutcome: node.subagents.length > 0 ? "degraded" : "supported"
      }),
      diagnostics: [
        ...createScheduleDiagnostics(node),
        ...(node.execution?.sandbox
          ? [createDiagnostic("warn", "Pi runtime relies on container and workspace isolation; Pi itself is not a sandbox engine")]
          : []),
        ...(node.mcpServers.length > 0
          ? [createDiagnostic("warn", "Pi runtime does not lower MCP server declarations in Spawnfile v0.1")]
          : []),
        ...(node.subagents.length > 0
          ? [createDiagnostic("warn", "Pi runtime groups compiled agents but does not preserve native parent-owned subagent semantics in v0.1")]
          : [])
      ],
      files: [
        ...createDocumentFiles("workspace", node.docs),
        ...createSkillFiles("workspace/skills", node.skills)
      ]
    };
  },
  async createContainerTargets(inputs): Promise<ContainerTarget[]> {
    return createContainerTargets(inputs);
  },
  name: "pi",
  prepareRuntimeAuth: preparePiRuntimeAuth,
  validateRuntimeOptions(options) {
    const diagnostics = [];
    if (
      options.engine !== undefined &&
      (typeof options.engine !== "string" ||
        !(PI_ENGINE_KINDS as readonly string[]).includes(options.engine))
    ) {
      diagnostics.push(createDiagnostic(
        "error",
        `Pi runtime option engine must be one of ${PI_ENGINE_KINDS.join(", ")}`
      ));
    }
    const unsupported = Object.keys(options).filter((key) =>
      key !== "restrict_to_workspace" && key !== "engine"
    );
    for (const key of unsupported) {
      diagnostics.push(createDiagnostic("warn", `Pi runtime option ${key} is not used yet`));
    }
    return diagnostics;
  }
};

export const daimonAdapter: RuntimeAdapter = {
  ...piAdapter,
  name: "daimon"
};

export const PI_RUNTIME_PACKAGE = `${PI_PACKAGE_NAME}@${PI_PACKAGE_VERSION}`;
