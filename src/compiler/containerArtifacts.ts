import type { EmittedFile } from "../runtime/index.js";

import { createEnvVariableMap, createRuntimeTargetPlans } from "./containerArtifactsPlans.js";
import {
  createRootfsFiles,
  renderDockerfile,
  renderEntrypoint,
  renderEnvExample
} from "./containerArtifactsRender.js";
import type { MoltnetArtifacts } from "./moltnetArtifacts.js";
import type {
  CompiledNodeArtifact,
  GeneratedContainerArtifacts
} from "./containerArtifactsTypes.js";
import type { CompilePlan } from "./types.js";

export type { CompiledNodeArtifact, GeneratedContainerArtifacts } from "./containerArtifactsTypes.js";

export interface ContainerArtifactOptions {
  hasStagedMoltnetBinaries?: boolean;
  moltnet?: MoltnetArtifacts | null;
}

export const createContainerArtifacts = async (
  plan: CompilePlan,
  compiledNodes: CompiledNodeArtifact[],
  options: ContainerArtifactOptions = {}
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
    ...(options.moltnet?.files ?? []),
    {
      content: await renderDockerfile(runtimePlans, {
        hasMoltnet: Boolean(options.moltnet),
        hasStagedMoltnetBinaries: options.hasStagedMoltnetBinaries,
        moltnetPublishedPorts: options.moltnet?.publishedPorts ?? []
      }),
      path: "Dockerfile"
    },
    {
      content: renderEntrypoint(
        runtimePlans,
        requiredSecrets.filter((secretName) => !modelSecretsRequired.includes(secretName)),
        {
          moltnet: options.moltnet
            ? {
                nodePlans: options.moltnet.nodePlans,
                serverPlans: options.moltnet.serverPlans
              }
            : undefined
        }
      ),
      path: "entrypoint.sh"
    },
    {
      content: renderEnvExample(envVariables),
      path: ".env.example"
    }
  ];

  const runtimePorts = runtimePlans.flatMap((plan) =>
    plan.publishedPort ? [plan.publishedPort] : []
  );
  const moltnetPorts = options.moltnet?.publishedPorts ?? [];
  const ports = [...new Set([...runtimePorts, ...moltnetPorts])].sort(
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
  const workspaceResources = [
    ...new Map(
      runtimePlans.flatMap((plan) =>
        (plan.resources ?? []).map((resource) => [
          `${resource.kind}:${resource.id}:${resource.linkPath}`,
          {
            backing_path: resource.backingPath,
            id: resource.id,
            kind: resource.kind,
            link_path: resource.linkPath,
            mode: resource.mode,
            mount: resource.mount,
            sharing: resource.sharing
          }
        ])
      )
    ).values()
  ].sort((left, right) => left.link_path.localeCompare(right.link_path) || left.id.localeCompare(right.id));

  return {
    executablePaths: ["entrypoint.sh"],
    files,
    ...(options.moltnet
      ? {
          moltnet: {
            nodePlans: options.moltnet.nodePlans,
            serverPlans: options.moltnet.serverPlans
          }
        }
      : {}),
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
      secrets_required: requiredSecrets,
      ...(workspaceResources.length > 0 ? { workspace_resources: workspaceResources } : {})
    }
  };
};
