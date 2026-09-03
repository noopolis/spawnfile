import { createHash } from "node:crypto";

import { buildDistributionReport, createDistributionImageLabels, DISTRIBUTION_REPORT_OUTPUT_FILE, normalizeProjectLabelSlug, WORLD_BINDINGS_IMAGE_PATH } from "../distribution/index.js";
import type { DistributionReport } from "../distribution/index.js";
import type { ContainerPersistentMountReport } from "../report/index.js";
import { DAIMON_LOCAL_RUNTIME_IDENTITY_ENV, loadLocalDaimonRuntimeIdentity, type EmittedFile, type RuntimeContainerPackageOverrides } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import { createMoltnetSummary, createOrganizationSummary } from "./containerArtifactSummaries.js";
import { createEnvVariableMap, createRuntimeTargetPlans } from "./containerArtifactsPlans.js";
import { createDockerIgnoreContent } from "./dockerBuildContext.js";
import { createDaimonTelemetryArtifacts } from "./daimonTelemetryArtifacts.js";
import { createRootfsFiles, renderDockerfile, renderEntrypoint, renderEnvExample } from "./containerArtifactsRender.js";
import { createMemoryArtifactBundle } from "./memoryArtifacts.js";
import type { MoltnetArtifacts } from "./moltnetArtifacts.js";
import type { MoltnetReleaseIdentity } from "./moltnetBinaries.js";
import type { CompiledNodeArtifact, GeneratedContainerArtifacts } from "./containerArtifactsTypes.js";
import { resolveWorkspaceResourceVolumes, type ResolvedTargetResourcePlan } from "./containerTargetResources.js";
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
  /** Resolved local overrides for runtime install npm packages, produced by
   * stageRuntimePackageOverrides.ts from a compile-time-only
   * RuntimePackageOverrideRequest (see compileProject.ts). Undefined for a
   * standard compile. */
  runtimePackageOverrides?: RuntimeContainerPackageOverrides;
}

/**
 * Enforces the `specs/SURFACES.md` Moltnet/daimon promise: "A release without
 * `daimon-bridge` is rejected; the public pi-only release cannot be relabeled
 * as dual-capability."
 *
 * A daimon Moltnet attachment lowers a node runtime config of
 * `kind: "daimon"` carrying `agent_id`, `token_env`, and `receipt_store_path`
 * (`./moltnetRuntimeConfig.ts`). No published Moltnet release implements that
 * kind -- `pkg/bridgeconfig` has no `RuntimeDaimon` through the latest tag, and
 * `pkg/nodeconfig` decodes with `DisallowUnknownFields()`, so the node exits on
 * `agent_id` at strict decode, before `Validate()` is even reached. The
 * entrypoint launches `moltnet node <config> &` and then `wait -n`
 * (`./containerEntrypointRender.ts`), so that exit tears the whole container
 * down. Both a locally built Moltnet (`./localMoltnetAuthority.ts`) and, since
 * the v0.1.18 pin, the published authority (`./moltnetReleaseAuthority.ts`) can
 * advertise `daimon-bridge`; anything older, including every release through
 * v0.1.17, advertises only `pi-bridge` and is still rejected here.
 *
 * This throws rather than warning, which is the opposite call from the other
 * unlowerable-declaration diagnostics in this compiler. Those keep working
 * projects compiling; here every affected project is already broken, and the
 * failure it replaces is an opaque JSON decode error at container boot.
 *
 * `receiptStorePath` is set on a node plan if and only if the attached agent's
 * runtime is daimon (`./moltnetArtifacts.ts`), so it is the exact daimon
 * signal on an already-resolved plan.
 */
const assertMoltnetDaimonBridgeCapability = (
  moltnet: MoltnetArtifacts | undefined | null,
  release: MoltnetReleaseIdentity | undefined
): void => {
  const daimonNetworks = [...new Set((moltnet?.nodePlans ?? [])
    .filter((nodePlan) => nodePlan.receiptStorePath !== undefined)
    .map((nodePlan) => nodePlan.networkId))].sort();
  if (daimonNetworks.length === 0) return;
  const capabilities: readonly string[] = release?.capabilities ?? [];
  if (capabilities.includes("daimon-bridge")) return;
  throw new SpawnfileError(
    "compile_error",
    `Moltnet release ${release?.version ?? "(unstaged)"} does not advertise the daimon-bridge capability, but `
      + `${daimonNetworks.length} network attachment(s) lower a daimon runtime bridge (${daimonNetworks.join(", ")}). `
      + "The published release implements pi-bridge only and rejects a daimon node config at strict JSON decode, so "
      + "the container would exit at boot. Build Moltnet locally (scripts/build-local-moltnet.mjs, then "
      + "SPAWNFILE_LOCAL_MOLTNET_RELEASE_DIR with SPAWNFILE_ALLOW_LOCAL_E2E=1) to stage a daimon-bridge release, or "
      + "remove the Moltnet attachment from the daimon agent(s)."
  );
};

export const createContainerArtifacts = async (
  plan: CompilePlan,
  compiledNodes: CompiledNodeArtifact[],
  options: ContainerArtifactOptions = {}
): Promise<GeneratedContainerArtifacts> => {
  assertMoltnetDaimonBridgeCapability(options.moltnet, options.moltnetRelease);
  const localDaimonIdentityPath = process.env[DAIMON_LOCAL_RUNTIME_IDENTITY_ENV]?.trim();
  const localDaimonIdentity = localDaimonIdentityPath ? await loadLocalDaimonRuntimeIdentity(localDaimonIdentityPath) : undefined;
  const runtimePlans = await createRuntimeTargetPlans(plan, compiledNodes, options.worldBindings, options.deploymentLineage);
  const daimonTelemetryArtifacts = createDaimonTelemetryArtifacts(plan, runtimePlans, compiledNodes);
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
  const { resources: resolvedWorkspaceResources, mounts: workspaceResourceMounts } =
    resolveWorkspaceResourceVolumes(runtimePlans);
  const persistentMountsById = new Map<string, { lifecycle?: "exclusive-reattach"; mount_path: string; reason: string; volume_name: string }>();
  for (const mount of memoryArtifacts.mounts) {
    const existing = persistentMountsById.get(mount.id);
    if (existing) {
      if (existing.mount_path !== mount.mount_path || existing.volume_name !== mount.volume_name) {
        throw new Error(
          `Container persistent mount ${mount.id} resolves to conflicting targets`
        );
      }
      continue;
    }
    persistentMountsById.set(mount.id, {
      ...(mount.lifecycle ? { lifecycle: mount.lifecycle } : {}),
      mount_path: mount.mount_path,
      reason: mount.reason,
      volume_name: mount.volume_name
    });
  }

  const persistentMountCandidates: ContainerPersistentMountReport[] = [
    ...memoryArtifacts.mounts,
    ...workspaceResourceMounts,
    ...daimonTelemetryArtifacts.mounts,
    ...runtimePlans.flatMap((runtimePlan) => runtimePlan.persistentMounts ?? []),
    ...((options.moltnet?.persistentMounts ?? []).map((mount) => ({
      id: mount.id,
      ...(mount.lifecycle ? { lifecycle: mount.lifecycle } : {}),
      mount_path: mount.mountPath,
      reason: mount.reason,
      volume_name: mount.volumeName
    })))
  ];
  const persistentMounts = persistentMountCandidates
    .sort((left, right) => left.id.localeCompare(right.id))
    .filter((mount) => {
      const existing = persistentMountsById.get(mount.id);
      if (existing) {
        if (
          existing.mount_path === mount.mount_path &&
          existing.volume_name === mount.volume_name &&
          existing.reason === mount.reason &&
          existing.lifecycle === mount.lifecycle
        ) {
          return true;
        }

        throw new Error(
          `Container persistent mount ${mount.id} resolves to conflicting targets`
        );
      }
      persistentMountsById.set(mount.id, {
        ...(mount.lifecycle ? { lifecycle: mount.lifecycle } : {}),
        mount_path: mount.mount_path,
        reason: mount.reason,
        volume_name: mount.volume_name
      });
      return true;
    });

  const runtimeInternalPorts = runtimePlans.flatMap((plan) =>
    plan.port ? [plan.port] : []
  );
  const internalPorts = [...new Set([...runtimeInternalPorts, ...(options.moltnet?.ports ?? [])])].sort(
    (left, right) => left - right
  );
  const runtimePublishedPorts = runtimePlans.flatMap((plan) =>
    plan.publishedPort ? [plan.publishedPort] : []
  );
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
      const telemetryMountIds = daimonTelemetryArtifacts.telemetryMountIdsByInstance.get(plan.id);
      return {
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
        ...(telemetryMountIds ? { telemetry_mount_ids: telemetryMountIds } : {}),
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
    persistentMounts: persistentMounts.map((mount) => ({
      durability: "persistent" as const,
      id: mount.id,
      kind: "volume" as const,
      ...(mount.lifecycle ? { lifecycle: mount.lifecycle } : {}),
      target: mount.mount_path
    })),
    portMappings,
    publishedPorts,
    resources: workspaceResources.map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      link_path: resource.link_path,
      mode: resource.mode,
      mount: resource.mount,
      sharing: resource.sharing
    })),
    runtimeInstances,
    ...(worldBindingsEvidence ? { worldBindings: worldBindingsEvidence } : {})
  });
  const distributionLabels = createDistributionImageLabels(
    projectSlug,
    distributionReport.compile_fingerprint
  );

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
        : undefined
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
            : undefined
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
      ...(localDaimonIdentity ? { local_daimon_runtime: {
        capability_receipt_sha256: localDaimonIdentity.capabilityReceipt,
        image_reference: localDaimonIdentity.imageReference,
        registry_authority: localDaimonIdentity.registryAuthority
      } } : {}),
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
