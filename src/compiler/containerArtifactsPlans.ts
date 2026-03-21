import path from "node:path";

import type { Secret } from "../manifest/index.js";
import {
  createRuntimeInstallRecipe,
  getRuntimeAdapter
} from "../runtime/index.js";
import type {
  ContainerTarget,
  ContainerTargetInput,
  EmittedFile,
  RuntimeContainerMeta
} from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import type { CompilePlan } from "./types.js";
import type {
  CompiledNodeArtifact,
  ContainerEnvVariable,
  RuntimeTargetPlan
} from "./containerArtifactsTypes.js";

const CONFIG_FILE_PLACEHOLDER = "<config-file>";
const INSTANCE_ROOT_PLACEHOLDER = "<instance-root>";

const MODEL_PROVIDER_ENV_VARS = new Map<string, string>([
  ["anthropic", "ANTHROPIC_API_KEY"],
  ["google", "GOOGLE_API_KEY"],
  ["groq", "GROQ_API_KEY"],
  ["mistral", "MISTRAL_API_KEY"],
  ["openai", "OPENAI_API_KEY"],
  ["openrouter", "OPENROUTER_API_KEY"],
  ["xai", "XAI_API_KEY"]
]);

const createDefaultTargets = (inputs: ContainerTargetInput[]): ContainerTarget[] =>
  inputs.map((input) => ({
    files: input.emittedFiles,
    id: `${input.kind}-${input.slug}`
  }));

const resolveTargetEnvFiles = (
  configPath: string,
  target: ContainerTarget
): Array<{ envName: string; filePath: string }> =>
  (target.envFiles ?? []).map((binding) => ({
    envName: binding.envName,
    filePath: path.posix.join(path.posix.dirname(configPath), binding.relativePath)
  }));

const assertTargetHasConfig = (
  runtimeName: string,
  targetId: string,
  meta: RuntimeContainerMeta,
  files: EmittedFile[]
): void => {
  if (!files.some((file) => file.path === meta.configFileName)) {
    throw new SpawnfileError(
      "runtime_error",
      `Container target ${targetId} for ${runtimeName} is missing ${meta.configFileName}`
    );
  }
};

const replaceContainerPathTemplate = (
  template: string,
  instanceRoot: string,
  configFileName: string
): string =>
  template
    .replaceAll(INSTANCE_ROOT_PLACEHOLDER, instanceRoot)
    .replaceAll(CONFIG_FILE_PLACEHOLDER, configFileName);

const resolveInstancePaths = (
  runtimeName: string,
  targetId: string,
  meta: RuntimeContainerMeta
): { configPath: string; homePath?: string; workspacePath: string } => {
  const instanceRoot = `/var/lib/spawnfile/instances/${runtimeName}/${targetId}`;

  return {
    configPath: replaceContainerPathTemplate(
      meta.instancePaths.configPathTemplate,
      instanceRoot,
      meta.configFileName
    ),
    homePath: meta.instancePaths.homePathTemplate
      ? replaceContainerPathTemplate(
          meta.instancePaths.homePathTemplate,
          instanceRoot,
          meta.configFileName
        )
      : undefined,
    workspacePath: replaceContainerPathTemplate(
      meta.instancePaths.workspacePathTemplate,
      instanceRoot,
      meta.configFileName
    )
  };
};

export const createEnvVariableMap = (
  compiledNodes: CompiledNodeArtifact[],
  runtimePlans: RuntimeTargetPlan[]
): Map<string, ContainerEnvVariable> => {
  const variables = new Map<string, ContainerEnvVariable>();

  const register = (name: string, required: boolean, description: string): void => {
    const current = variables.get(name);
    if (!current) {
      variables.set(name, { description, name, required });
      return;
    }

    variables.set(name, {
      ...current,
      required: current.required || required
    });
  };

  const registerSecret = (secret: Secret): void => {
    register(secret.name, secret.required, "Declared in Spawnfile secrets");
  };

  const registerProvider = (provider: string): void => {
    const envName =
      MODEL_PROVIDER_ENV_VARS.get(provider) ??
      `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
    register(envName, true, `Model provider auth for ${provider}`);
  };

  for (const node of compiledNodes) {
    if (node.value.kind === "agent") {
      for (const secret of node.value.secrets) {
        registerSecret(secret);
      }

      const executionModel = node.value.execution?.model;
      if (executionModel?.primary) {
        registerProvider(executionModel.primary.provider);
      }
      for (const fallback of executionModel?.fallback ?? []) {
        registerProvider(fallback.provider);
      }
      continue;
    }

    for (const secret of node.value.shared.secrets) {
      registerSecret(secret);
    }
  }

  for (const runtimePlan of runtimePlans) {
    for (const variable of runtimePlan.meta.env ?? []) {
      register(variable.name, variable.required, variable.description);
    }
  }

  return variables;
};

export const createRuntimeTargetPlans = async (
  plan: CompilePlan,
  compiledNodes: CompiledNodeArtifact[]
): Promise<RuntimeTargetPlan[]> => {
  const runtimeNames = Object.keys(plan.runtimes).sort();
  const runtimePlans: RuntimeTargetPlan[] = [];

  for (const runtimeName of runtimeNames) {
    const adapter = getRuntimeAdapter(runtimeName);
    const recipe = await createRuntimeInstallRecipe(runtimeName);
    const targetInputs = compiledNodes
      .filter((node) => node.runtimeName === runtimeName && node.emittedFiles.length > 0)
      .map(
        (node): ContainerTargetInput => ({
          emittedFiles: node.emittedFiles,
          id: `${node.kind}:${node.slug}`,
          kind: node.kind,
          slug: node.slug,
          value: node.value
        })
      );

    const targets =
      (await adapter.createContainerTargets?.(targetInputs)) ??
      createDefaultTargets(targetInputs);

    targets.forEach((target, index) => {
      assertTargetHasConfig(runtimeName, target.id, adapter.container, target.files);
      const instancePaths = resolveInstancePaths(runtimeName, target.id, adapter.container);
      runtimePlans.push({
        envFiles: resolveTargetEnvFiles(instancePaths.configPath, target),
        id: target.id,
        instancePaths,
        meta: adapter.container,
        port: adapter.container.port ? adapter.container.port + index : undefined,
        runtimeName,
        runtimeRoot: recipe.runtimeRoot,
        targetFiles: target.files
      });
    });
  }

  return runtimePlans;
};
