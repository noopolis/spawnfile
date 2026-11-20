import type { ResolvedAgentNode } from "../../compiler/types.js";
import { createWorkspaceAgentScaffold } from "../workspaceScaffold.js";
import { MNEME_PACKAGE } from "../mnemeMcp.js";
import { hermesSubagentDiagnostic } from "./subagents.js";
import { assertSupportedHermesSurfaces, buildHermesSurfaceEnvBindings, hermesSurfaceEnvCommand } from "./surfaces.js";
import { assertHermesMcp, hermesMcpEnvBindings, hermesMemoryCapability } from "./nativeFeatures.js";
import { hermesCronGatewayCommand, hermesCronMount, hermesScheduleCapability, hermesScheduleFiles } from "./schedules.js";
import { RuntimeAdapterBase } from "../adapterBase.js";
import { createAgentCapabilities, createDiagnostic, createDocumentFiles, createSkillFiles } from "../common.js";
import { hermesLogin } from "./login.js";
import type { RuntimeHostIntegration } from "../hostTypes.js";
import { nativeTrainingCapability } from "../nativeTraining.js";
import type {
  AdapterCompileResult, ContainerTarget, ContainerTargetInput, RuntimeAdapter, RuntimeContainerMeta,
  RuntimeSystemInstructionSurface
} from "../types.js";
import {
  assertHermesModel, buildHermesConfig, hermesConfigFile, hermesModelBindings,
  hermesSkillRoot, refuse, resolveHermesModels
} from "./config.js";
import { hermesAuthDirectory, hermesAuthRoute, hermesAuthRouteFile, prepareHermesRuntimeAuth } from "./auth.js";
import { hermesAuthLaunchCommand } from "./authLaunch.js";
import { hermesEnvCommand, hermesEnvironment, hermesWiring } from "./instance.js";
import { hermesImageRef, hermesInstall } from "./install.js";

function checkAgent(node: ResolvedAgentNode) {
  assertSupportedHermesSurfaces(node.surfaces);
  assertHermesMcp(node);
  if (node.expose) refuse("public ingress for the native service");
  return resolveHermesModels(node);
}

class HermesAgentAdapter extends RuntimeAdapterBase {
  readonly name = "hermes-agent";
  readonly scaffoldAgentProject = () => createWorkspaceAgentScaffold({
    runtime: this.name, provider: "openai", modelName: "gpt-5.4", authMethod: "codex"
  });
  override readonly install = hermesInstall;
  readonly wiring = hermesWiring;
  readonly prepareRuntimeAuth = prepareHermesRuntimeAuth;
  readonly host: RuntimeHostIntegration = {
    async prepareImageAuth(instance, { authProfile, containerCredentialUid, tempRoot }) {
      return (await prepareHermesRuntimeAuth({
        authProfile, containerCredentialUid, env: {}, instance, outputDirectory: "", tempRoot
      })).mountArgs;
    }
  };
  readonly training = { login: hermesLogin, ...nativeTrainingCapability("hermes-agent",
    async () => (await import("./training.js")).hermesTrainingDriver) };
  override readonly assertSupportedModelTarget = assertHermesModel;
  readonly assertSupportedSurfaces = assertSupportedHermesSurfaces;
  readonly preflightAgent = checkAgent;

  readonly container: RuntimeContainerMeta = {
    adapterManagedAuthMethods: ["codex", "grok", "subscription"],
    configFileName: hermesConfigFile,
    homeEnv: "HERMES_HOME",
    globalNpmPackages: [MNEME_PACKAGE],
    instancePaths: {
      configPathTemplate: "<instance-root>/hermes/<config-file>",
      homePathTemplate: "<instance-root>/hermes",
      workspacePathTemplate: "<instance-root>/workspace"
    },
    standaloneBaseImage: hermesImageRef,
    startCommand: [
      ...hermesEnvCommand,
      ...Object.entries(hermesEnvironment("<home-path>", "<workspace-path>")).map(([name, value]) => `${name}=${value}`),
      ...hermesSurfaceEnvCommand, ...hermesAuthLaunchCommand, ...hermesCronGatewayCommand
    ],
    postRootfsCommands: [
      // The pinned Hermes atomic writer stages and replaces beside the resolved symlink target.
      // Both auth.json and its flock must follow the same writable profile mount.
      "find /var/lib/spawnfile/instances/hermes-agent -mindepth 2 -maxdepth 2 -type d -name hermes " +
        `-exec bash -c 'for dir; do mkdir -m 0700 "$dir/${hermesAuthDirectory}" && ` +
        `ln -s "${hermesAuthDirectory}/auth.json" "$dir/auth.json" && ` +
        `ln -s "${hermesAuthDirectory}/auth.lock" "$dir/auth.lock" || exit; done' bash {} +`,
      "find /var/lib/spawnfile/instances/hermes-agent -mindepth 2 -maxdepth 2 -type d -name hermes -exec chmod 0700 {} +",
      `find /var/lib/spawnfile/instances/hermes-agent -mindepth 3 -maxdepth 3 -type f \\( -path '*/hermes/config.yaml' -o -path '*/hermes/${hermesAuthRouteFile}' \\) -exec chmod 0600 {} +`
    ],
    systemDeps: ["bash", "ca-certificates", "curl", "util-linux"]
  };

  readonly systemInstructionSurface: RuntimeSystemInstructionSurface = {
    placement: "append_inline",
    resolvePath: () => "workspace/AGENTS.md"
  };

  readonly validateRuntimeOptions = (options: Record<string, unknown>) =>
    Object.keys(options).map(option => createDiagnostic("error", `Hermes Agent does not support runtime option ${option}`));

  async compileAgent(node: ResolvedAgentNode): Promise<AdapterCompileResult> {
    const models = checkAgent(node);
    const nativeRoute = models.map(model => hermesAuthRoute(model.provider, model.auth.method)).find(Boolean);
    const memory = hermesMemoryCapability(node);
    const schedule = hermesScheduleCapability(node);
    const delegation = hermesSubagentDiagnostic(node);
    const soul = node.docs.find(document => document.role === "soul");
    return {
      capabilities: createAgentCapabilities(node, {
        ...memory,
        ...schedule,
        sandboxOutcome: "unsupported",
        subagentOutcome: "degraded", subagentMessage: delegation
      }),
      diagnostics: [
        ...(delegation ? [createDiagnostic("warn", delegation)] : []),
        ...(node.memoryAccess?.length && memory.memoryOutcome === "degraded" ? [createDiagnostic("warn", memory.memoryMessage)] : []),
        ...(schedule.scheduleOutcome === "degraded" ? [createDiagnostic("warn", schedule.scheduleMessage)] : [])
      ],
      files: [
        { path: hermesConfigFile, content: buildHermesConfig(models, node) },
        { path: `home/${hermesAuthRouteFile}`, content: `${nativeRoute ?? "-"}\n` },
        ...hermesScheduleFiles(node),
        ...createDocumentFiles("workspace", node.docs),
        ...(soul ? [{ path: "home/SOUL.md", content: soul.content }] : []),
        ...createSkillFiles(hermesSkillRoot, node.skills)
      ]
    };
  }

  async createContainerTargets(inputs: ContainerTargetInput[]): Promise<ContainerTarget[]> {
    return inputs.map(input => {
      if (input.value.kind !== "agent") return refuse("a shared team container target");
      const models = checkAgent(input.value);
      const bindings = [...hermesModelBindings(models), ...hermesMcpEnvBindings(input.value), ...buildHermesSurfaceEnvBindings(input.value.surfaces)];
      return {
        id: `agent-${input.slug}`,
        sourceIds: [input.id],
        files: input.emittedFiles,
        ...(models.some(model => this.container.adapterManagedAuthMethods?.includes(model.auth.method)) ? {
          opaqueMountTargets: [`<instance-root>/hermes/${hermesAuthDirectory}`]
        } : {}),
        ...(bindings.length ? { configEnvBindings: bindings } : {}),
        persistentMounts: [hermesCronMount(input.slug), {
          id: `hermes-agent-${input.slug}-workspace`,
          mountPath: "<instance-root>/workspace",
          reason: "Hermes Agent workspace"
        }]
      };
    });
  }
}

export const hermesAgentAdapter: RuntimeAdapter = new HermesAgentAdapter();
