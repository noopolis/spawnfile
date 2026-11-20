import type { ResolvedAgentNode, ResolvedAgentSurfaces } from "../../compiler/types.js";
import { SpawnfileError } from "../../shared/index.js";
import { RuntimeAdapterBase } from "../adapterBase.js";
import {
  createAgentCapabilities, createDiagnostic, createDocumentFiles, createSkillFiles, WORKSPACE_SKILL_BASE_DIRECTORY
} from "../common.js";
import { nativeTrainingCapability } from "../nativeTraining.js";
import type { AdapterCompileResult, ContainerTargetInput, RuntimeAdapter, RuntimeSystemInstructionSurface } from "../types.js";
import { assertOpenCodeModel, openCodeConfig } from "./config.js";
import { openCodeInstall, opencodeConfigFile, opencodeContainer, opencodeWiring } from "./launch.js";

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
  for (const server of node.mcpServers) {
    if (server.tools) {
      throw new SpawnfileError("validation_error", `OpenCode MCP server ${server.name} cannot enforce a Spawnfile tools allowlist`);
    }
    if (server.auth && server.auth.mode !== "bearer") {
      throw new SpawnfileError("validation_error", `OpenCode MCP server ${server.name} requires explicit bearer auth when an auth block is present`);
    }
    if (server.transport !== "stdio" && server.env && Object.keys(server.env).length > 0) {
      throw new SpawnfileError("validation_error", `OpenCode MCP server ${server.name} cannot set a remote process environment`);
    }
  }
}

class OpenCodeAdapter extends RuntimeAdapterBase {
  readonly name = "opencode";
  override readonly install = openCodeInstall;
  readonly container = opencodeContainer;
  readonly wiring = opencodeWiring;
  readonly training = nativeTrainingCapability("opencode", async () => (await import("./training.js")).opencodeTrainingDriver);
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
    const docs = createDocumentFiles("workspace", node.docs);
    const disabled = node.schedule?.kind === "disabled";
    const warnings = [
      ...(node.execution?.sandbox ? ["OpenCode does not enforce Spawnfile execution.sandbox"] : []),
      ...(node.schedule && !disabled ? ["OpenCode has no Spawnfile schedule integration"] : []),
      ...(node.subagents.length ? ["OpenCode does not invoke declared Spawnfile subagents"] : []),
      ...(node.memoryAccess?.length ? ["OpenCode does not connect declared Spawnfile memory banks"] : [])
    ];
    return {
      capabilities: createAgentCapabilities(node, {
        memoryOutcome: "degraded",
        memoryMessage: "OpenCode does not connect declared Spawnfile memory banks",
        sandboxOutcome: "degraded",
        scheduleOutcome: disabled ? "supported" : "degraded",
        scheduleMessage: disabled ? "Schedule is disabled" : "OpenCode has no Spawnfile schedule integration",
        subagentOutcome: "degraded"
      }),
      diagnostics: warnings.map(message => createDiagnostic("warn", message)),
      files: [
        ...docs,
        ...createSkillFiles(WORKSPACE_SKILL_BASE_DIRECTORY, node.skills),
        { path: opencodeConfigFile, content: openCodeConfig(node, docs) }
      ]
    };
  }

  async createContainerTargets(inputs: ContainerTargetInput[]) {
    return inputs.map(input => ({
      id: `${input.kind}-${input.slug}`,
      files: input.emittedFiles,
      sourceIds: [input.id],
      configEnvBindings: input.value.kind === "agent" ? input.value.mcpServers.flatMap(server =>
        server.auth?.mode === "bearer" ? [{
          envName: server.auth.secret,
          jsonPath: ["mcp", server.name, "headers", "Authorization"],
          transform: "bearer" as const
        }] : []
      ) : []
    }));
  }
}

export const opencodeAdapter: RuntimeAdapter = new OpenCodeAdapter();
