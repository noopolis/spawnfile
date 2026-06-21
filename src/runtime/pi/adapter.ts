import path from "node:path";

import {
  listEffectiveExecutionModelTargets,
  listExecutionModelSecretNames
} from "../../compiler/modelEnv.js";
import type { ResolvedAgentNode } from "../../compiler/types.js";
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
  PI_PACKAGE_NAME,
  PI_PACKAGE_VERSION,
  renderPiApp,
  renderPiAppConfig,
  renderPiPackageJson
} from "./appTemplate.js";
import { preparePiRuntimeAuth } from "./runAuth.js";

const PI_CONFIG_FILE = "pi-app.json";
const PI_CONTROL_PORT = 19690;

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

export const piAdapter: RuntimeAdapter = {
  assertSupportedModelTarget(target) {
    if (target.endpoint) {
      throw new SpawnfileError(
        "validation_error",
        "Pi runtime does not support custom or local model endpoints yet"
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

    throw new SpawnfileError(
      "validation_error",
      `Pi runtime does not support model auth method ${target.auth.method} for provider ${target.provider}`
    );
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
    standaloneBaseImage: "node:24-bookworm-slim",
    startCommand: ["node", "<runtime-root>/app.mjs", "<config-path>"],
    systemDeps: ["bash", "ca-certificates", "curl", "git", "procps"]
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
        scheduleMessage: scheduleOutcome.message,
        scheduleOutcome: scheduleOutcome.outcome
      }),
      diagnostics: createScheduleDiagnostics(node),
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
    const unsupported = Object.keys(options).filter((key) => key !== "restrict_to_workspace");
    for (const key of unsupported) {
      diagnostics.push(createDiagnostic("warn", `Pi runtime option ${key} is not used yet`));
    }
    return diagnostics;
  }
};

export const PI_RUNTIME_PACKAGE = `${PI_PACKAGE_NAME}@${PI_PACKAGE_VERSION}`;
