import { createHash } from "node:crypto";
import { buildDistributionReport, createDistributionImageLabels, DISTRIBUTION_REPORT_OUTPUT_FILE, normalizeProjectLabelSlug, WORLD_BINDINGS_IMAGE_PATH } from "../distribution/index.js";
import type { DistributionReport } from "../distribution/index.js";
import type { CompileReport, ContainerPersistentMountReport } from "../report/index.js";
import type { EmittedFile, RuntimeContainerPackageOverrides } from "../runtime/index.js";
import { selectedRuntimeHosts } from "../runtime/hostSelection.js";
import { SpawnfileError } from "../shared/index.js";
import { createMoltnetSummary, createOrganizationSummary } from "./containerArtifactSummaries.js";
import { createEnvVariableMap, createRuntimeTargetPlans } from "./containerArtifactsPlans.js";
import { createDockerIgnoreContent } from "./dockerBuildContext.js";
import { createRootfsFiles, renderDockerfile, renderEntrypoint, renderEnvExample } from "./containerArtifactsRender.js";
import { createMemoryArtifactBundle } from "./memoryArtifacts.js";
import { resolveRecordingReport } from "./recordingReport.js";
import { assertMoltnetBridgeCapabilities } from "./moltnetBridgeCapabilities.js";
import type { MoltnetArtifacts } from "./moltnetArtifacts.js";
import type { MoltnetReleaseIdentity } from "./moltnetBinaries.js";
import type { CompiledNodeArtifact, GeneratedContainerArtifacts } from "./containerArtifactsTypes.js";
import { resolveWorkspaceResourceVolumes, type ResolvedTargetResourcePlan } from "./containerTargetResources.js";
import { mergePersistentMounts } from "./containerPersistentMounts.js";
import type { CompilePlan } from "./types.js";
import { SIMFILE_WORLD_BINDINGS_VERSION, WORLD_BINDINGS_OUTPUT_FILE, type ResolvedWorldBindings } from "./worldBindings.js";
export type { CompiledNodeArtifact, GeneratedContainerArtifacts } from "./containerArtifactsTypes.js";

export interface ContainerArtifactOptions {
  deploymentLineage?: string;
  generatedAt?: string;
  hasStagedMoltnetBinaries?: boolean;
  hasWorkspaceBundles?: boolean;
  moltnet?: MoltnetArtifacts | null;
  moltnetRelease?: MoltnetReleaseIdentity;
  worldBindings?: ResolvedWorldBindings;
  workspaceGitResources?: CompileReport["workspace_git_resources"];
  workspaceBundles?: CompileReport["workspace_bundles"];
  /** Opt-in install overrides resolved by stageRuntimePackageOverrides. */
  runtimePackageOverrides?: RuntimeContainerPackageOverrides;
}

export const createContainerArtifacts = async (
  plan: CompilePlan,
  compiledNodes: CompiledNodeArtifact[],
  options: ContainerArtifactOptions = {}
): Promise<GeneratedContainerArtifacts> => {
  assertMoltnetBridgeCapabilities(options.moltnet?.nodePlans ?? [], options.moltnetRelease);
  const hosts = selectedRuntimeHosts(Object.keys(plan.runtimes).sort());
  const localImageReports = await Promise.all(hosts.map(async ({ name, host }) => {
    const identity = await host.localImageReport?.();
    return identity ? [[`local_${name}_runtime`, identity] as const] : [];
  }));
  const runtimePlans = await createRuntimeTargetPlans(plan, compiledNodes, options.worldBindings, options.deploymentLineage);
  const envVariableMap = createEnvVariableMap(compiledNodes, runtimePlans, options.moltnet);
  const projectedWorldTokenEnvNames = [...new Set(
    runtimePlans.flatMap((runtimePlan) => runtimePlan.worldTokenEnvNames ?? [])
  )].sort();
  const worldTokenEnvNames = (options.worldBindings?.artifact.bindings ?? [])
    .map((binding) => binding.token_env)
    .sort();
  const recipeEnvNames = new Set(
    runtimePlans.flatMap((runtimePlan) => Object.keys(runtimePlan.recipeEnv ?? {}))
  );
  const moltnetSecretEnvNames = new Set(
    (options.moltnet?.serverPlans ?? []).flatMap((serverPlan) =>
      serverPlan.secretPatches.map((patch) => patch.envName)
    )
  );
  for (const name of worldTokenEnvNames) {
    if (envVariableMap.has(name) || recipeEnvNames.has(name) || moltnetSecretEnvNames.has(name)) {
      throw new SpawnfileError(
        "validation_error",
        `World token env ${name} conflicts with an existing environment authority`
      );
    }
  }
  for (const name of projectedWorldTokenEnvNames) {
    envVariableMap.set(name, {
      categories: ["runtime"],
      description: "World bearer token for a native runtime projection",
      generated: false,
      name,
      required: true
    });
  }
  const envVariables = [...envVariableMap.values()].sort(
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
  const memoryArtifacts = createMemoryArtifactBundle(plan, options.deploymentLineage);
  const recording = resolveRecordingReport(plan, memoryArtifacts.memories, options.workspaceGitResources);
  const { resources: resolvedWorkspaceResources, mounts: workspaceResourceMounts } =
    resolveWorkspaceResourceVolumes(runtimePlans);
  const persistentMountCandidates: ContainerPersistentMountReport[] = [
    ...memoryArtifacts.mounts,
    ...workspaceResourceMounts,
    ...runtimePlans.flatMap((runtimePlan) => runtimePlan.persistentMounts ?? []),
    ...((options.moltnet?.persistentMounts ?? []).map((mount) => ({
      ...(mount.declaredVolumeName ? { declared_volume_name: mount.declaredVolumeName } : {}),
      id: mount.id,
      ...(mount.lifecycle ? { lifecycle: mount.lifecycle } : {}),
      mount_path: mount.mountPath,
      reason: mount.reason,
      volume_name: mount.volumeName
    })))
  ];
  const persistentMounts = mergePersistentMounts(persistentMountCandidates);

  const runtimeInternalPorts = runtimePlans.flatMap((plan) => plan.port ? [plan.port] : []);
  const internalPorts = [...new Set([...runtimeInternalPorts, ...(options.moltnet?.ports ?? [])])].sort(
    (left, right) => left - right
  );
  const runtimePublishedPorts = runtimePlans.flatMap((plan) => plan.publishedPort ? [plan.publishedPort] : []);
  const publishedPorts = [
    ...new Set([...runtimePublishedPorts, ...(options.moltnet?.publishedPorts ?? [])])
  ].sort((left, right) => left - right);
  const portMappings = runtimePlans
    .flatMap((plan) =>
      plan.port && plan.publishedPort
        ? [{ internal_port: plan.port, published_port: plan.publishedPort }]
        : []
    )
    .sort((left, right) =>
      left.published_port - right.published_port
      || left.internal_port - right.internal_port
    );
  const runtimeHomes = [
    ...new Set(runtimePlans.flatMap((plan) => (plan.instancePaths.homePath ? [plan.instancePaths.homePath] : [])))
  ].sort();
  const runtimeInstances = runtimePlans
    .map((plan) => {
      return {
        ...(plan.agentPathsByNodeId ? { agent_paths: Object.fromEntries(
          Object.entries(plan.agentPathsByNodeId).map(([id, paths]) => [id, {
            workspace_path: paths.workspacePath, home_path: paths.homePath, skill_roots: paths.skillRoots
          }])
        ) } : {}),
        config_path: plan.instancePaths.configPath,
        home_path: plan.instancePaths.homePath ?? null,
        id: plan.id,
        internal_port: plan.port ?? null,
        model_auth_methods: plan.modelAuthMethods,
        model_secrets_required: plan.modelSecretsRequired,
        ...(plan.engineByNodeId && Object.keys(plan.engineByNodeId).length > 0
          ? { engine_by_node_id: plan.engineByNodeId }
          : {}),
        node_ids: [...(plan.sourceIds ?? [])],
        published_port: plan.publishedPort ?? null,
        runtime: plan.runtimeName,
        workspace_path: plan.instancePaths.workspacePath
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const runtimesInstalled = [...new Set(runtimePlans.map((plan) => plan.runtimeName))].sort();
  const workspaceResources = [
    ...new Map(
      runtimePlans.flatMap((plan) =>
        ((plan.resources ?? []) as ResolvedTargetResourcePlan[]).map((resource) => [
          `${resource.kind}:${resource.id}:${resource.linkPath}`,
          {
            backing_path: resource.backingPath,
            id: resource.id,
            kind: resource.kind,
            link_path: resource.linkPath,
            mode: resource.mode,
            mount: resource.mount,
            mount_path: resource.linkPath,
            replacement_sentinel: resource.replacementSentinel ? {
              path: resource.replacementSentinel,
              result: "verified_on_startup" as const
            } : undefined,
            resolved_identity: resource.resolvedIdentity,
            sharing: resource.sharing,
            volume_name: resource.volumeName ?? null
          }
        ])
      )
    ).values()
  ].sort((left, right) => left.link_path.localeCompare(right.link_path) || left.id.localeCompare(right.id));
  const moltnetSummary = createMoltnetSummary(options.moltnet, options.moltnetRelease);

  const organization = createOrganizationSummary(plan, compiledNodes);
  const projectSlug = normalizeProjectLabelSlug(organization.project);
  const mergedModelAuthMethods = Object.assign(
    {},
    ...runtimePlans.map((runtimePlan) => runtimePlan.modelAuthMethods)
  ) as DistributionReport["model_auth_methods"];
  const moltnetNetworks = [
    ...new Map(
      (options.moltnet?.serverPlans ?? []).map((serverPlan) => [
        serverPlan.networkId,
        {
          binding: "env" as const,
          id: serverPlan.networkId,
          server_mode: serverPlan.mode
        }
      ])
    ).values()
  ];
  const worldBindingsEvidence = options.worldBindings
    ? {
        artifact_path: WORLD_BINDINGS_IMAGE_PATH,
        digest: `sha256:${createHash("sha256").update(options.worldBindings.canonicalBytes).digest("hex")}`,
        schema: SIMFILE_WORLD_BINDINGS_VERSION
      } as const
    : undefined;
  const distributionReport = buildDistributionReport({
    envVariables: envVariables.map((variable) => ({
      categories: variable.categories,
      generated: variable.generated,
      name: variable.name,
      required: variable.required
    })),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    internalPorts,
    modelAuthMethods: mergedModelAuthMethods,
    moltnetNetworks,
    organization,
    // Derived volume names encode private host paths. Only author-declared
    // names are portable; image consumers must honor them verbatim.
    persistentMounts: persistentMounts.map((mount) => ({
      ...(mount.declared_volume_name ? { declared_volume_name: mount.declared_volume_name } : {}),
      durability: "persistent" as const,
      id: mount.id,
      kind: "volume" as const,
      ...(mount.lifecycle ? { lifecycle: mount.lifecycle } : {}),
      target: mount.mount_path
    })),
    portMappings,
    publishedPorts,
    ...(recording ? {
      recording,
      workspaceGitResources: options.workspaceGitResources?.map(({ id, commit, sha256, agent_node_ids, declared_by }) => ({ id, commit, sha256, agent_node_ids: agent_node_ids!, ...(declared_by ? { declared_by } : {}) })),
      workspaceBundles: options.workspaceBundles?.map(({ id, sha256, origin, agent_node_ids, declared_by }) => ({ id, sha256, origin, agent_node_ids: agent_node_ids!, ...(declared_by ? { declared_by } : {}) }))
    } : {}),
    resources: workspaceResources.map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      link_path: resource.link_path,
      mode: resource.mode,
      mount: resource.mount,
      sharing: resource.sharing
    })),
    runtimeInstances: runtimeInstances.map(({ agent_paths: _paths, ...instance }) => instance),
    ...(worldBindingsEvidence ? { worldBindings: worldBindingsEvidence } : {})
  });
  const distributionLabels = createDistributionImageLabels(projectSlug, distributionReport.compile_fingerprint);

  const files: EmittedFile[] = [
    ...createRootfsFiles(
      runtimePlans,
      persistentMounts.map((mount) => mount.mount_path),
      options.moltnet
        ? {
            externalParticipantArtifacts: options.moltnet.externalParticipantArtifacts,
            nodePlans: options.moltnet.nodePlans,
            serverPlans: options.moltnet.serverPlans
          }
        : undefined,
      persistentMounts
    ),
    ...(options.moltnet?.files ?? []),
    ...(options.worldBindings
      ? [{ content: options.worldBindings.canonicalBytes, mode: 0o600, path: WORLD_BINDINGS_OUTPUT_FILE }]
      : []),
    {
      content: `${JSON.stringify(distributionReport, null, 2)}\n`,
      path: DISTRIBUTION_REPORT_OUTPUT_FILE
    },
    {
      content: await renderDockerfile(runtimePlans, {
        distribution: {
          labels: distributionLabels,
          reportOutputFile: DISTRIBUTION_REPORT_OUTPUT_FILE,
          ...(options.worldBindings
            ? { worldBindingsOutputFile: WORLD_BINDINGS_OUTPUT_FILE }
            : {})
        },
        hasMoltnet: Boolean(options.moltnet),
        hasStagedMoltnetBinaries: options.hasStagedMoltnetBinaries,
        hasWorkspaceBundles: options.hasWorkspaceBundles,
        ...(options.moltnet
          ? {
              moltnet: {
                nodePlans: options.moltnet.nodePlans,
                serverPlans: options.moltnet.serverPlans
              }
            }
          : {}),
        moltnetPublishedPorts: options.moltnet?.publishedPorts ?? [],
        persistentMountPaths: persistentMounts.map((mount) => mount.mount_path),
        runtimePackageOverrides: options.runtimePackageOverrides
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
                externalParticipantArtifacts: options.moltnet.externalParticipantArtifacts ?? [],
                nodePlans: options.moltnet.nodePlans,
                serverPlans: options.moltnet.serverPlans
              }
            : undefined,
          persistentMounts,
          persistentMountPaths: persistentMounts.map((mount) => mount.mount_path)
        }
      ),
      path: "entrypoint.sh"
    },
    {
      content: renderEnvExample(envVariables),
      path: ".env.example"
    },
    {
      content: createDockerIgnoreContent(),
      path: ".dockerignore"
    }
  ];

  return {
    distribution: {
      fingerprint: distributionReport.compile_fingerprint,
      labels: distributionLabels,
      report: distributionReport
    },
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
      internal_ports: internalPorts,
      ...Object.fromEntries(localImageReports.flat()),
      model_secrets_required: modelSecretsRequired,
      ...(moltnetSummary ? { moltnet: moltnetSummary } : {}),
      port_mappings: portMappings,
      ports: publishedPorts,
      published_ports: publishedPorts,
      runtime_instances: runtimeInstances,
      runtime_homes: runtimeHomes,
      runtime_secrets_required: runtimeSecretsRequired,
      runtimes_installed: runtimesInstalled,
      secrets_required: requiredSecrets,
      ...(memoryArtifacts.memories.length > 0 ? { memory: memoryArtifacts.memories } : {}),
      ...(persistentMounts.length > 0 ? { persistent_mounts: persistentMounts } : {}),
      ...(workspaceResources.length > 0 ? { workspace_resources: workspaceResources } : {})
    }
  };
};
