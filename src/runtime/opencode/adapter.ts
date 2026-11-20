import type { ResolvedAgentNode, ResolvedAgentSurfaces } from "../../compiler/types.js";
import { listEffectiveExecutionModelTargets } from "../../compiler/modelEnv.js";
import { SpawnfileError } from "../../shared/index.js";
import { createWorkspaceAgentScaffold } from "../workspaceScaffold.js";
import { assertOpenCodeMcp, openCodeMcpCapabilities, openCodeMcpEnvBindings, openCodeMemoryCapability } from "./nativeFeatures.js";
import { RuntimeAdapterBase } from "../adapterBase.js";
import {
  createAgentCapabilities, createDiagnostic, createDocumentFiles, createSkillFiles, WORKSPACE_SKILL_BASE_DIRECTORY
} from "../common.js";
import { openCodeLogin } from "./login.js";
import { nativeTrainingCapability } from "../nativeTraining.js";
import type { AdapterCompileResult, ContainerTargetInput, RuntimeAdapter, RuntimeSystemInstructionSurface } from "../types.js";
import { opencodeHost, opencodeLoginDirectory, openCodeSubscriptionProvider, prepareOpenCodeRuntimeAuth } from "./auth.js";
import { assertOpenCodeModel, openCodeConfig } from "./config.js";
import { openCodeInstall, opencodeConfigFile, opencodeContainer, opencodeWiring } from "./launch.js";
import { opencodeLaunchFile, renderOpenCodeLaunch } from "./launchScript.js";

function assertSurfaces(surfaces: ResolvedAgentSurfaces | undefined): void {
  for (const surface of Object.keys(surfaces ?? {}) as Array<keyof ResolvedAgentSurfaces>) {
    if (surface !== "moltnet" && surfaces?.[surface] !== undefined) {
      throw new SpawnfileError("validation_error", `OpenCode does not support the ${surface} surface`);
    }
  }
}

function assertAgent(node: ResolvedAgentNode): void {
  assertSurfaces(node.surfaces);
  if (node.expose) {
    throw new SpawnfileError("validation_error", "OpenCode serve binds to loopback and cannot be exposed");
  }
  if (node.execution?.model?.fallback?.length) {
    throw new SpawnfileError("validation_error", "OpenCode does not implement Spawnfile execution.model fallback");
  }
  assertOpenCodeMcp(node);
}

class OpenCodeAdapter extends RuntimeAdapterBase {
  readonly name = "opencode";
  readonly scaffoldAgentProject = () => createWorkspaceAgentScaffold({
    runtime: this.name, provider: "openai", modelName: "gpt-5.4", authMethod: "codex"
  });
  override readonly install = openCodeInstall;
  readonly container = opencodeContainer;
  readonly host = opencodeHost;
  readonly prepareRuntimeAuth = prepareOpenCodeRuntimeAuth;
  readonly wiring = opencodeWiring;
  readonly training = { login: openCodeLogin, ...nativeTrainingCapability("opencode", async () => (await import("./training.js")).opencodeTrainingDriver) };
  readonly assertSupportedModelTarget = assertOpenCodeModel;
  readonly assertSupportedSurfaces = assertSurfaces;
  readonly preflightAgent = assertAgent;
  readonly systemInstructionSurface: RuntimeSystemInstructionSurface = {
    placement: "append_pointer",
    resolvePath: () => "workspace/AGENTS.md"
  };

  readonly validateRuntimeOptions = (options: Record<string, unknown>) =>
    Object.keys(options).sort().map(key => createDiagnostic("error", `OpenCode runtime option ${key} is unsupported`));

  async compileAgent(node: ResolvedAgentNode): Promise<AdapterCompileResult> {
    assertAgent(node);
    const [primary] = listEffectiveExecutionModelTargets(node.execution);
    const docs = createDocumentFiles("workspace", node.docs);
    const disabled = node.schedule?.kind === "disabled";
    const memory = openCodeMemoryCapability(node);
    const warnings = [
      ...(node.execution?.sandbox ? ["OpenCode does not enforce Spawnfile execution.sandbox"] : []),
      ...(node.schedule && !disabled ? ["OpenCode has no Spawnfile schedule integration"] : []),
      ...(node.subagents.length ? ["OpenCode does not invoke declared Spawnfile subagents"] : []),
      ...(node.memoryAccess?.length && memory.memoryOutcome === "degraded" ? [memory.memoryMessage] : [])
    ];
    return {
      capabilities: [...createAgentCapabilities(node, {
        ...memory,
        sandboxOutcome: "degraded",
        scheduleOutcome: disabled ? "supported" : "degraded",
        scheduleMessage: disabled ? "Schedule is disabled" : "OpenCode has no Spawnfile schedule integration",
        subagentOutcome: "degraded"
      }).filter(capability => !capability.key.startsWith("mcp.")), ...openCodeMcpCapabilities(node)],
      diagnostics: warnings.map(message => createDiagnostic("warn", message)),
      files: [
        ...docs,
        ...createSkillFiles(WORKSPACE_SKILL_BASE_DIRECTORY, node.skills),
        { path: opencodeConfigFile, content: openCodeConfig(node, docs) },
        { path: `home/${opencodeLaunchFile}`, content: renderOpenCodeLaunch(primary) }
      ]
    };
  }

  async createContainerTargets(inputs: ContainerTargetInput[]) {
    return inputs.map(input => ({
      id: `${input.kind}-${input.slug}`,
      files: input.emittedFiles,
      sourceIds: [input.id],
      ...(input.value.kind === "agent" && openCodeSubscriptionProvider(listEffectiveExecutionModelTargets(input.value.execution)[0]) ? {
        opaqueMountTargets: [`<instance-root>/home/${opencodeLoginDirectory}`]
      } : {}),
      configEnvBindings: input.value.kind === "agent" ? openCodeMcpEnvBindings(input.value) : []
    }));
  }
}

export const opencodeAdapter: RuntimeAdapter = new OpenCodeAdapter();
