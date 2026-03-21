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

  const files: EmittedFile[] = [
    ...createRootfsFiles(runtimePlans),
    {
      content: await renderDockerfile(runtimePlans),
      path: "Dockerfile"
    },
    {
      content: renderEntrypoint(runtimePlans, requiredSecrets),
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
  const runtimesInstalled = [...new Set(runtimePlans.map((plan) => plan.runtimeName))].sort();

  return {
    executablePaths: ["entrypoint.sh"],
    files,
    report: {
      dockerfile: "Dockerfile",
      entrypoint: "entrypoint.sh",
      env_example: ".env.example",
      ports,
      runtimes_installed: runtimesInstalled,
      secrets_required: requiredSecrets
    }
  };
};
