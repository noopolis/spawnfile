import type { EmittedFile } from "../runtime/index.js";

import { createEnvVariableMap, createRuntimeTargetPlans } from "./containerArtifactsPlans.js";
import {
  createRootfsFiles,
  renderDockerfile,
  renderEntrypoint,
  renderEnvExample
} from "./containerArtifactsRender.js";
import type {
  CompiledNodeArtifact,
  GeneratedContainerArtifacts
} from "./containerArtifactsTypes.js";
import type { CompilePlan } from "./types.js";

export type { CompiledNodeArtifact, GeneratedContainerArtifacts } from "./containerArtifactsTypes.js";

export const createContainerArtifacts = async (
  plan: CompilePlan,
  compiledNodes: CompiledNodeArtifact[]
): Promise<GeneratedContainerArtifacts> => {
  const runtimePlans = await createRuntimeTargetPlans(plan, compiledNodes);
  const envVariables = [...createEnvVariableMap(compiledNodes, runtimePlans).values()].sort(
    (left, right) => left.name.localeCompare(right.name)
  );
  const requiredSecrets = envVariables
    .filter((variable) => variable.required)
    .map((variable) => variable.name)
    .sort();
  const modelSecretsRequired = envVariables
    .filter((variable) => variable.required && variable.categories.includes("model"))
    .map((variable) => variable.name)
    .sort();
  const runtimeSecretsRequired = envVariables
    .filter((variable) => variable.required && variable.categories.includes("runtime"))
    .map((variable) => variable.name)
    .sort();

  const files: EmittedFile[] = [
    ...createRootfsFiles(runtimePlans),
    {
      content: await renderDockerfile(runtimePlans),
      path: "Dockerfile"
    },
    {
      content: renderEntrypoint(
        runtimePlans,
        requiredSecrets.filter((secretName) => !modelSecretsRequired.includes(secretName))
      ),
      path: "entrypoint.sh"
    },
    {
      content: renderEnvExample(envVariables),
      path: ".env.example"
    }
  ];

  const ports = [...new Set(runtimePlans.flatMap((plan) => (plan.port ? [plan.port] : [])))].sort(
    (left, right) => left - right
  );
  const runtimeHomes = [
    ...new Set(runtimePlans.flatMap((plan) => (plan.instancePaths.homePath ? [plan.instancePaths.homePath] : [])))
  ].sort();
  const runtimeInstances = runtimePlans
    .map((plan) => ({
      config_path: plan.instancePaths.configPath,
      home_path: plan.instancePaths.homePath ?? null,
      id: plan.id,
      model_auth_methods: plan.modelAuthMethods,
      model_secrets_required: plan.modelSecretsRequired,
      runtime: plan.runtimeName
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const runtimesInstalled = [...new Set(runtimePlans.map((plan) => plan.runtimeName))].sort();

  return {
    executablePaths: ["entrypoint.sh"],
    files,
    report: {
      dockerfile: "Dockerfile",
      entrypoint: "entrypoint.sh",
      env_example: ".env.example",
      model_secrets_required: modelSecretsRequired,
      ports,
      runtime_instances: runtimeInstances,
      runtime_homes: runtimeHomes,
      runtime_secrets_required: runtimeSecretsRequired,
      runtimes_installed: runtimesInstalled,
      secrets_required: requiredSecrets
    }
  };
};
