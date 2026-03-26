import path from "node:path";

import type { Secret } from "../manifest/index.js";
import {
  createRuntimeInstallRecipe,
  getRuntimeAdapter
} from "../runtime/index.js";
import type { ModelAuthMethod } from "../shared/index.js";
import type {
  ContainerTarget,
  ContainerTargetInput,
  EmittedFile,
  RuntimeContainerMeta
} from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import {
  listExecutionModelSecretNames,
  resolveExecutionModelAuthMethods
} from "./modelEnv.js";
import { listAgentSurfaceSecretNames } from "./discordSurface.js";
import type { CompilePlan } from "./types.js";
import type {
  CompiledNodeArtifact,
  ContainerEnvVariable,
  RuntimeTargetPlan
} from "./containerArtifactsTypes.js";

const CONFIG_FILE_PLACEHOLDER = "<config-file>";
const INSTANCE_ROOT_PLACEHOLDER = "<instance-root>";

const createDefaultTargets = (inputs: ContainerTargetInput[]): ContainerTarget[] =>
  inputs.map((input) => ({
    files: input.emittedFiles,
    id: `${input.kind}-${input.slug}`,
    sourceIds: [input.id]
  }));

const resolveTargetEnvFiles = (
  configPath: string,
  target: ContainerTarget
): Array<{ envName: string; filePath: string }> =>
  (target.envFiles ?? []).map((binding) => ({
    envName: binding.envName,
    filePath: path.posix.join(path.posix.dirname(configPath), binding.relativePath)
  }));

const resolveTargetConfigEnvBindings = (
  meta: RuntimeContainerMeta,
  target: ContainerTarget
): RuntimeContainerMeta["configEnvBindings"] =>
  [...(meta.configEnvBindings ?? []), ...(target.configEnvBindings ?? [])];

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

  const register = (
    name: string,
    required: boolean,
    description: string,
    category: "model" | "project" | "runtime" | "surface"
  ): void => {
    const current = variables.get(name);
    if (!current) {
      variables.set(name, {
        categories: [category],
        description,
        name,
        required
      });
      return;
    }

    variables.set(name, {
      ...current,
      categories: [...new Set([...current.categories, category])],
      required: current.required || required
    });
  };

  const registerSecret = (secret: Secret): void => {
    register(secret.name, secret.required, "Declared in Spawnfile secrets", "project");
  };

  for (const node of compiledNodes) {
    if (node.value.kind === "agent") {
      for (const secret of node.value.secrets) {
        registerSecret(secret);
      }

      for (const secretName of listExecutionModelSecretNames(node.value.execution)) {
        register(secretName, true, `Model provider auth for ${secretName}`, "model");
      }

      for (const secretName of listAgentSurfaceSecretNames(node.value.surfaces)) {
        register(
          secretName,
          true,
          "Discord bot token for declared Discord surfaces",
          "surface"
        );
      }
      continue;
    }

    for (const secret of node.value.shared.secrets) {
      registerSecret(secret);
    }
  }

  for (const runtimePlan of runtimePlans) {
    for (const variable of runtimePlan.meta.env ?? []) {
      register(variable.name, variable.required, variable.description, "runtime");
    }
  }

  return variables;
};

const resolveTargetModelSecrets = (
  target: ContainerTarget,
  inputs: ContainerTargetInput[]
): string[] => {
  const sourceIds = new Set(target.sourceIds ?? []);
  if (sourceIds.size === 0) {
    return [];
  }

  const secretNames = new Set<string>();

  for (const input of inputs) {
    if (!sourceIds.has(input.id) || input.value.kind !== "agent") {
      continue;
    }

    for (const secretName of listExecutionModelSecretNames(input.value.execution)) {
      secretNames.add(secretName);
    }
  }

  return [...secretNames].sort();
};

const resolveTargetModelAuthMethods = (
  target: ContainerTarget,
  inputs: ContainerTargetInput[]
): Record<string, ModelAuthMethod> => {
  const sourceIds = new Set(target.sourceIds ?? []);
  if (sourceIds.size === 0) {
    return {};
  }

  const methods = new Map<string, ModelAuthMethod>();

  for (const input of inputs) {
    if (!sourceIds.has(input.id) || input.value.kind !== "agent") {
      continue;
    }

    for (const [provider, method] of Object.entries(
      resolveExecutionModelAuthMethods(input.value.execution)
    )) {
      const existingMethod = methods.get(provider);
      if (existingMethod && existingMethod !== method) {
        throw new SpawnfileError(
          "validation_error",
          `Container target ${target.id} declares conflicting auth methods for provider ${provider}`
        );
      }

      methods.set(provider, method);
    }
  }

  return Object.fromEntries([...methods.entries()].sort(([left], [right]) => left.localeCompare(right)));
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
        configEnvBindings: resolveTargetConfigEnvBindings(adapter.container, target) ?? [],
        envFiles: resolveTargetEnvFiles(instancePaths.configPath, target),
        id: target.id,
        instancePaths,
        meta: adapter.container,
        modelAuthMethods: resolveTargetModelAuthMethods(target, targetInputs),
        modelSecretsRequired: resolveTargetModelSecrets(target, targetInputs),
        port: adapter.container.port ? adapter.container.port + index : undefined,
        runtimeName,
        runtimeRoot: recipe.runtimeRoot,
        targetFiles: target.files
      });
    });
  }

  return runtimePlans;
};
