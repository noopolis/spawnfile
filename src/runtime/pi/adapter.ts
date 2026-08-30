import { listEffectiveExecutionModelTargets } from "../../compiler/modelEnv.js";
import type { ResolvedAgentNode, ResolvedAgentSurfaces } from "../../compiler/types.js";
import { readUtf8File, resolveProjectPath } from "../../filesystem/index.js";
import { SpawnfileError } from "../../shared/index.js";
import {
  CLI_ENGINE_SKILL_BASE_DIRECTORIES,
  createAgentCapabilities,
  createDiagnostic,
  createDocumentFiles,
  createSkillFiles
} from "../common.js";
import type {
  AdapterCompileResult,
  ContainerTarget,
  EmittedFile,
  RuntimeAdapter
} from "../types.js";

import {
  resolveScriptedEngineCommandOption,
  resolveScriptedEngineStagedPath
} from "./appScriptedEngine.js";
import {
  isPiEveryScheduleValue,
  PI_BUILTIN_TOOLS,
  PI_ENGINE_KINDS,
  PI_PACKAGE_NAME,
  PI_PACKAGE_VERSION,
  PI_THINKING_FORMATS,
  PI_THINKING_LEVELS,
  resolvePiEngine
} from "./appTemplate.js";
import {
  createPiContainerTargets,
  PI_CONFIG_FILE,
  PI_CONTROL_PORT,
} from "./containerTargets.js";
import { preparePiRuntimeAuth } from "./runAuth.js";

/**
 * Stages a `scripted`-engine's `engine_command` script into this agent's
 * emitted workspace files, the same way `createDocumentFiles`/
 * `createSkillFiles` stage docs/skills: read once at compile time (relative
 * to the declaring manifest, via `resolveProjectPath(node.sourcePath ?? node.source, ...)`,
 * mirroring `surfaces.ts`'s `loadResolvedDocuments`) and emitted as a
 * `workspace/...` file, which `createContainerTargets` below relocates to
 * `workspace/agents/<slug>/...` (`moveWorkspaceFileToAgentWorkspace`) just
 * like every other per-agent workspace file. Returns `[]` for every engine
 * other than `scripted` (and defensively for a `scripted` engine missing
 * `engine_command`, though `validateRuntimeOptions` below already rejects
 * that before `compileAgent` ever runs).
 */
const createScriptedEngineFiles = async (node: ResolvedAgentNode): Promise<EmittedFile[]> => {
  const option = resolveScriptedEngineCommandOption(node);
  const stagedPath = resolveScriptedEngineStagedPath(node);
  if (!option || !stagedPath) {
    return [];
  }

  const sourcePath = resolveProjectPath(node.sourcePath ?? node.source, option);
  const content = await readUtf8File(sourcePath);

  return [
    {
      content,
      mode: 0o755,
      path: `workspace/${stagedPath}`
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

const createMemoryConsolidationDiagnostics = (node: ResolvedAgentNode) =>
  (node.memoryAccess ?? []).flatMap((access) =>
    access.bank.consolidation.mode === "scheduled" &&
    access.bank.consolidation.schedule &&
    !isPiEveryScheduleValue(access.bank.consolidation.schedule)
      ? [
          createDiagnostic(
            "warn",
            `Pi generated runtime app supports every memory consolidation schedules in Spawnfile v0.1; memory bank ${access.bank.id} consolidation is degraded`
          )
        ]
      : []
  );

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
    globalNpmPackages: ["@anthropic-ai/claude-code", "@openai/codex@0.142.3"],
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
        memoryMessage: "Daimon exposes Mneme memory through generated runtime turns",
        memoryOutcome: "supported",
        ...moltnetCapabilityOptions(node),
        mcpOutcome: node.mcpServers.length > 0 ? "degraded" : "supported",
        sandboxOutcome: node.execution?.sandbox ? "degraded" : "supported",
        scheduleMessage: scheduleOutcome.message,
        scheduleOutcome: scheduleOutcome.outcome,
        subagentOutcome: node.subagents.length > 0 ? "degraded" : "supported"
      }),
	      diagnostics: [
	        ...createScheduleDiagnostics(node),
	        ...createMemoryConsolidationDiagnostics(node),
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
        ...createSkillFiles(CLI_ENGINE_SKILL_BASE_DIRECTORIES, node.skills),
        ...(await createScriptedEngineFiles(node))
      ]
    };
  },
  async createContainerTargets(inputs): Promise<ContainerTarget[]> {
    return createPiContainerTargets(inputs);
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
    if (
      options.engine === "scripted" &&
      (typeof options.engine_command !== "string" || options.engine_command.trim().length === 0)
    ) {
      diagnostics.push(createDiagnostic(
        "error",
        "Pi runtime option engine_command is required (a fixture-relative script path) when engine is scripted"
      ));
    }
    if (
      options.thinking !== undefined &&
      (typeof options.thinking !== "string" ||
        !(PI_THINKING_LEVELS as readonly string[]).includes(options.thinking))
    ) {
      diagnostics.push(createDiagnostic(
        "error",
        `Pi runtime option thinking must be one of ${PI_THINKING_LEVELS.join(", ")}`
      ));
    }
    if (
      options.thinking_format !== undefined &&
      (typeof options.thinking_format !== "string" ||
        !(PI_THINKING_FORMATS as readonly string[]).includes(options.thinking_format))
    ) {
      diagnostics.push(createDiagnostic(
        "error",
        `Pi runtime option thinking_format must be one of ${PI_THINKING_FORMATS.join(", ")}`
      ));
    }
    if (
      options.tools !== undefined &&
      (!Array.isArray(options.tools)
        || options.tools.some((item) =>
          typeof item !== "string"
          || !(PI_BUILTIN_TOOLS as readonly string[]).includes(item))
        || new Set(options.tools).size !== options.tools.length)
    ) {
      diagnostics.push(createDiagnostic(
        "error",
        `Pi runtime option tools must contain unique values from ${PI_BUILTIN_TOOLS.join(", ")}`
      ));
    }
    if (
      options.raw_training_capture_turns !== undefined
      && (!Number.isSafeInteger(options.raw_training_capture_turns)
        || typeof options.raw_training_capture_turns !== "number"
        || options.raw_training_capture_turns < 1
        || options.raw_training_capture_turns > 100_000)
    ) {
      diagnostics.push(createDiagnostic(
        "error",
        "Pi runtime option raw_training_capture_turns must be an integer between 1 and 100000"
      ));
    }
    const unsupported = Object.keys(options).filter((key) =>
      key !== "restrict_to_workspace"
      && key !== "engine"
      && key !== "engine_command"
      && key !== "thinking"
      && key !== "thinking_format"
      && key !== "tools"
      && key !== "raw_training_capture_turns"
    );
    for (const key of unsupported) {
      diagnostics.push(createDiagnostic("warn", `Pi runtime option ${key} is not used yet`));
    }
    return diagnostics;
  }
};

export const PI_RUNTIME_PACKAGE = `${PI_PACKAGE_NAME}@${PI_PACKAGE_VERSION}`;
