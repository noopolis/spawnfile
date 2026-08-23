import type { Secret } from "../manifest/index.js";
import { createRuntimeInstallRecipe, getRuntimeAdapter } from "../runtime/index.js";
import type { ContainerTargetInput } from "../runtime/index.js";

import { listAgentSurfaceSecretNames } from "./agentSurfaces.js";
import type {
  CompiledNodeArtifact,
  ContainerEnvVariable,
  RuntimeTargetPlan
} from "./containerArtifactsTypes.js";
import { resolveTargetResources } from "./containerTargetResources.js";
import {
  assertTargetHasConfig,
  createDefaultTargets,
  resolveInstancePaths,
  resolveTargetConfigEnvBindings,
  resolveTargetEnvFiles,
  resolveTargetExposure,
  resolveTargetModelAuthMethods,
  resolveTargetModelSecrets,
  resolveTargetPackages
} from "./containerTargetPlanResolution.js";
import { listExecutionModelSecretNames } from "./modelEnv.js";
import { createPersistentVolumeName } from "./moltnetArtifactPaths.js";
import type { MoltnetArtifacts } from "./moltnetArtifacts.js";
import type { CompilePlan } from "./types.js";
import { findWorldBindingForNode, type ResolvedWorldBindings } from "./worldBindings.js";

export const createEnvVariableMap = (
  compiledNodes: CompiledNodeArtifact[],
  runtimePlans: RuntimeTargetPlan[],
  moltnet?: MoltnetArtifacts | null
): Map<string, ContainerEnvVariable> => {
  const variables = new Map<string, ContainerEnvVariable>();

  const register = (
    name: string,
    required: boolean,
    description: string,
    category: "model" | "project" | "runtime" | "surface",
    generated = false
  ): void => {
    const current = variables.get(name);
    if (!current) {
      variables.set(name, {
        categories: [category],
        description,
        generated,
        name,
        required
      });
      return;
    }

    variables.set(name, {
      ...current,
      categories: [...new Set([...current.categories, category])],
      generated: current.generated && generated,
      required: current.required || required
    });
  };

  const registerSecret = (secret: Secret): void => {
    register(secret.name, secret.required, "Declared in Spawnfile secrets", "project");
  };

  for (const node of compiledNodes) {
    if (node.value.kind === "agent") {
      for (const secret of node.value.secrets) registerSecret(secret);
      if (node.runtimeName !== "daimon") {
        for (const secretName of listExecutionModelSecretNames(node.value.execution)) {
          register(secretName, true, `Model provider auth for ${secretName}`, "model");
        }
      }
      for (const secretName of listAgentSurfaceSecretNames(node.value.surfaces)) {
        register(secretName, true, "Bot token for declared agent surfaces", "surface");
      }
      continue;
    }
    for (const secret of node.value.shared.secrets) registerSecret(secret);
  }

  for (const runtimePlan of runtimePlans) {
    for (const variable of runtimePlan.meta.env ?? []) {
      register(
        variable.name,
        variable.required,
        variable.description,
        "runtime",
        variable.generated ?? false
      );
    }
    for (const binding of runtimePlan.targetConfigEnvBindings ?? []) {
      register(
        binding.envName,
        true,
        `Injected into ${runtimePlan.runtimeName} runtime config`,
        "runtime",
        binding.generated ?? false
      );
    }
  }

  for (const serverPlan of moltnet?.serverPlans ?? []) {
    for (const patch of serverPlan.secretPatches) {
      register(
        patch.envName,
        true,
        `Managed Moltnet secret for ${serverPlan.networkId}`,
        "surface"
      );
    }
  }

  return variables;
};

export const createRuntimeTargetPlans = async (
  plan: CompilePlan,
  compiledNodes: CompiledNodeArtifact[],
  worldBindings?: ResolvedWorldBindings
): Promise<RuntimeTargetPlan[]> => {
  const runtimeNames = Object.keys(plan.runtimes).sort();
  const runtimePlans: RuntimeTargetPlan[] = [];

  for (const runtimeName of runtimeNames) {
    const adapter = getRuntimeAdapter(runtimeName);
    const recipe = await createRuntimeInstallRecipe(runtimeName);
    const targetInputs = compiledNodes
      .filter((node) =>
        node.runtimeName === runtimeName && (node.emittedFiles.length > 0 || runtimeName === "daimon")
      )
      .map((node): ContainerTargetInput => {
        const id = node.id ?? `${node.kind}:${node.slug}`;
        const worldBinding = node.kind === "agent"
          ? findWorldBindingForNode(worldBindings, id)
          : undefined;
        return {
          emittedFiles: node.emittedFiles,
          id,
          kind: node.kind,
          slug: node.slug,
          value: node.value,
          ...(worldBinding ? { worldBinding } : {})
        };
      });

    const targets =
      (await adapter.createContainerTargets?.(targetInputs)) ??
      createDefaultTargets(targetInputs);

    targets.forEach((target, index) => {
      assertTargetHasConfig(runtimeName, target.id, adapter.container, target.files);
      const instancePaths = resolveInstancePaths(runtimeName, target.id, adapter.container);
      const portStride = adapter.container.portStride ?? 1;
      runtimePlans.push({
        configEnvBindings: resolveTargetConfigEnvBindings(adapter.container, target) ?? [],
        ...(target.engineByNodeId ? { engineByNodeId: target.engineByNodeId } : {}),
        envFiles: resolveTargetEnvFiles(instancePaths.configPath, target),
        packages: resolveTargetPackages(target, targetInputs),
        id: target.id,
        instancePaths,
        meta: adapter.container,
        modelAuthMethods: runtimeName === "daimon" ? {} : resolveTargetModelAuthMethods(target, targetInputs),
        modelSecretsRequired: runtimeName === "daimon" ? [] : resolveTargetModelSecrets(target, targetInputs),
        ...(target.opaqueMountTargets ? { opaqueMountTargets: [...target.opaqueMountTargets].sort() } : {}),
        ...(target.persistentMounts ? { persistentMounts: target.persistentMounts.map((mount) => ({
          id: mount.id,
          mount_path: mount.mountPath.replaceAll("<instance-root>", instancePaths.instanceRoot),
          reason: mount.reason,
          volume_name: createPersistentVolumeName(plan.root, mount.id)
        })).sort((left, right) => left.id.localeCompare(right.id)) } : {}),
        port: adapter.container.port ? adapter.container.port + (index * portStride) : undefined,
        publishedPort:
          resolveTargetExposure(target, targetInputs) && adapter.container.port
            ? adapter.container.port + (index * portStride)
            : undefined,
        recipeEnv: recipe.env,
        resources: resolveTargetResources(target, targetInputs, instancePaths, adapter.container),
        runtimeName,
        runtimeRoot: recipe.runtimeRoot,
        sourceIds: [...(target.sourceIds ?? [])].sort(),
        targetConfigEnvBindings: target.configEnvBindings,
        targetFiles: target.files,
        ...(target.worldTokenEnvNames
          ? { worldTokenEnvNames: target.worldTokenEnvNames }
          : {})
      });
    });
  }

  return runtimePlans;
};
