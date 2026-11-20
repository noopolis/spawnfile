import type { ResolvedAgentNode } from "../../compiler/types.js";
import { RuntimeAdapterBase } from "../adapterBase.js";
import { createAgentCapabilities, createDiagnostic, createDocumentFiles, createSkillFiles } from "../common.js";
import { nativeTrainingCapability } from "../nativeTraining.js";
import type {
  AdapterCompileResult, ContainerTarget, ContainerTargetInput, RuntimeAdapter, RuntimeContainerMeta,
  RuntimeSystemInstructionSurface
} from "../types.js";
import {
  assertHermesModel, assertHermesSurfaces, buildHermesConfig, hermesConfigFile, hermesModelSecret,
  hermesProvider, hermesSkillRoot, refuse, resolveHermesModel
} from "./config.js";
import { hermesEnvCommand, hermesEnvironment, hermesWiring } from "./instance.js";
import { hermesBinary, hermesImageRef, hermesInstall } from "./install.js";

function checkAgent(node: ResolvedAgentNode) {
  assertHermesSurfaces(node.surfaces);
  if (node.expose) refuse("public ingress for the native service");
  return resolveHermesModel(node);
}

class HermesAgentAdapter extends RuntimeAdapterBase {
  readonly name = "hermes-agent";
  override readonly install = hermesInstall;
  readonly wiring = hermesWiring;
  readonly training = nativeTrainingCapability("hermes-agent",
    async () => (await import("./training.js")).hermesTrainingDriver);
  override readonly assertSupportedModelTarget = assertHermesModel;
  readonly assertSupportedSurfaces = assertHermesSurfaces;
  readonly preflightAgent = checkAgent;

  readonly container: RuntimeContainerMeta = {
    configFileName: hermesConfigFile,
    homeEnv: "HERMES_HOME",
    instancePaths: {
      configPathTemplate: "<instance-root>/hermes/<config-file>",
      homePathTemplate: "<instance-root>/hermes",
      workspacePathTemplate: "<instance-root>/workspace"
    },
    standaloneBaseImage: hermesImageRef,
    startCommand: [
      ...hermesEnvCommand,
      ...Object.entries(hermesEnvironment("<home-path>", "<workspace-path>")).map(([name, value]) => `${name}=${value}`),
      hermesBinary, "gateway", "run", "--no-supervise", "--external-supervisor"
    ],
    postRootfsCommands: [
      "find /var/lib/spawnfile/instances/hermes-agent -mindepth 2 -maxdepth 2 -type d -name hermes -exec chmod 0700 {} +",
      "find /var/lib/spawnfile/instances/hermes-agent -mindepth 3 -maxdepth 3 -type f -path '*/hermes/config.yaml' -exec chmod 0600 {} +"
    ],
    systemDeps: ["bash", "ca-certificates", "curl"]
  };

  readonly systemInstructionSurface: RuntimeSystemInstructionSurface = {
    placement: "append_inline",
    resolvePath: () => "workspace/AGENTS.md"
  };

  readonly validateRuntimeOptions = (options: Record<string, unknown>) =>
    Object.keys(options).map(option => createDiagnostic("error", `Hermes Agent does not support runtime option ${option}`));

  async compileAgent(node: ResolvedAgentNode): Promise<AdapterCompileResult> {
    const model = checkAgent(node);
    const soul = node.docs.find(document => document.role === "soul");
    return {
      capabilities: createAgentCapabilities(node, {
        mcpOutcome: "unsupported",
        memoryOutcome: "unsupported",
        memoryMessage: "Spawnfile memory banks are unavailable in this runtime",
        sandboxOutcome: "unsupported",
        scheduleOutcome: "unsupported",
        scheduleMessage: "Spawnfile schedules are unavailable in this runtime",
        subagentOutcome: "unsupported"
      }),
      diagnostics: [],
      files: [
        { path: hermesConfigFile, content: buildHermesConfig(model) },
        ...createDocumentFiles("workspace", node.docs),
        ...(soul ? [{ path: "home/SOUL.md", content: soul.content }] : []),
        ...createSkillFiles(hermesSkillRoot, node.skills)
      ]
    };
  }

  async createContainerTargets(inputs: ContainerTargetInput[]): Promise<ContainerTarget[]> {
    return inputs.map(input => {
      if (input.value.kind !== "agent") return refuse("a shared team container target");
      const secret = hermesModelSecret(checkAgent(input.value));
      return {
        id: `agent-${input.slug}`,
        sourceIds: [input.id],
        files: input.emittedFiles,
        ...(secret ? { configEnvBindings: [{ envName: secret, jsonPath: ["providers", hermesProvider, "api_key"] }] } : {}),
        persistentMounts: [{
          id: `hermes-agent-${input.slug}-workspace`,
          mountPath: "<instance-root>/workspace",
          reason: "Hermes Agent workspace"
        }]
      };
    });
  }
}

export const hermesAgentAdapter: RuntimeAdapter = new HermesAgentAdapter();
