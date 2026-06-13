import {
  buildDistributionReport,
  createDistributionImageLabels,
  DISTRIBUTION_REPORT_OUTPUT_FILE,
  normalizeProjectLabelSlug
} from "../distribution/index.js";
import type {
  DistributionOrganizationSummary,
  DistributionReport
} from "../distribution/index.js";
import type { EmittedFile } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import { createEnvVariableMap, createRuntimeTargetPlans } from "./containerArtifactsPlans.js";
import {
  createRootfsFiles,
  renderDockerfile,
  renderEntrypoint,
  renderEnvExample
} from "./containerArtifactsRender.js";
import type { MoltnetArtifacts, MoltnetServerPlan } from "./moltnetArtifacts.js";
import type {
  CompiledNodeArtifact,
  GeneratedContainerArtifacts
} from "./containerArtifactsTypes.js";
import type { CompilePlan } from "./types.js";

export type { CompiledNodeArtifact, GeneratedContainerArtifacts } from "./containerArtifactsTypes.js";

export interface ContainerArtifactOptions {
  generatedAt?: string;
  hasStagedMoltnetBinaries?: boolean;
  moltnet?: MoltnetArtifacts | null;
}

const createOrganizationSummary = (
  plan: CompilePlan,
  compiledNodes: CompiledNodeArtifact[]
): DistributionOrganizationSummary => {
  const nodes = compiledNodes.map((node) => ({
    id: node.id ?? `${node.kind}:${node.slug}`,
    kind: node.kind,
    name: node.value.name,
    runtimeName: node.runtimeName,
    source: node.value.source
  }));
  const rootNode =
    nodes.find((node) => node.source === plan.root)
    ?? nodes.find((node) => !plan.edges.some((edge) => edge.to === node.id))
    ?? nodes[0];
  if (!rootNode) {
    throw new SpawnfileError(
      "compile_error",
      `Unable to resolve the root node for ${plan.root}`
    );
  }

  const memberEdges = plan.edges.filter((edge) => edge.kind === "team_member");
  const teamsByAgent = new Map<string, string[]>();
  for (const edge of memberEdges) {
    teamsByAgent.set(edge.to, [...(teamsByAgent.get(edge.to) ?? []), edge.from]);
  }

  const agentNodes = nodes.filter((node) => node.kind === "agent");
  const teamNodes = nodes.filter((node) => node.kind === "team");
  const agentIds = new Set(agentNodes.map((node) => node.id));

  return {
    agents: agentNodes
      .map((node) => ({
        id: node.id,
        name: node.name,
        runtime: node.runtimeName,
        teams: [...(teamsByAgent.get(node.id) ?? [])].sort()
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    project: rootNode.name,
    teams: teamNodes
      .map((node) => ({
        agents: memberEdges
          .filter((edge) => edge.from === node.id && agentIds.has(edge.to))
          .map((edge) => edge.to)
          .sort(),
        id: node.id,
        name: node.name
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  };
};

const resolveMoltnetOperatorTokenSecret = (
  plan: MoltnetServerPlan
): string | undefined => {
  const client = plan.server.auth.client;
  if (!client) {
    return undefined;
  }

  if (client.token_env) {
    return client.token_env;
  }

  if (client.token_path) {
    return client.token_path;
  }

  if (!client.token_id) {
    return undefined;
  }

  return plan.server.auth.tokens?.find((token) => token.id === client.token_id)?.secret;
};

const createMoltnetSummary = (
  moltnet: MoltnetArtifacts | undefined | null
): GeneratedContainerArtifacts["report"]["moltnet"] | undefined => {
  if (!moltnet) {
    return undefined;
  }

  return {
    node_plans: moltnet.nodePlans.map((plan) => ({
      config_path: plan.configPath,
      network_id: plan.networkId
    })),
    server_plans: moltnet.serverPlans.map((plan) => {
      const operatorTokenSecret = resolveMoltnetOperatorTokenSecret(plan);

      return {
        auth_mode: plan.server.auth.mode,
        base_url: plan.baseUrl,
        ...(plan.configPath ? { config_path: plan.configPath } : {}),
        ...(plan.server.mode === "managed"
          ? { direct_messages: plan.server.direct_messages }
          : {}),
        id: plan.id,
        mode: plan.mode,
        network_id: plan.networkId,
        ...(operatorTokenSecret ? { operator_token_secret: operatorTokenSecret } : {}),
        ...(plan.port ? { port: plan.port } : {}),
        ...(plan.server.auth.public_read !== undefined
          ? { public_read: plan.server.auth.public_read }
          : {}),
        rooms: plan.rooms.map((room) => ({
          id: room.id,
          members: [...room.members],
          ...(room.visibility ? { visibility: room.visibility } : {}),
          ...(room.write_policy ? { write_policy: room.write_policy } : {})
        })),
        ...(plan.server.mode === "managed"
          ? { store_kind: plan.server.store.kind }
          : {})
      };
    })
  };
};

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
  const persistentMounts = (options.moltnet?.persistentMounts ?? [])
    .map((mount) => ({
      id: mount.id,
      mount_path: mount.mountPath,
      reason: mount.reason,
      volume_name: mount.volumeName
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

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
    .map((plan) => ({
      config_path: plan.instancePaths.configPath,
      home_path: plan.instancePaths.homePath ?? null,
      id: plan.id,
      internal_port: plan.port ?? null,
      model_auth_methods: plan.modelAuthMethods,
      model_secrets_required: plan.modelSecretsRequired,
      node_ids: [...(plan.sourceIds ?? [])],
      published_port: plan.publishedPort ?? null,
      runtime: plan.runtimeName,
      workspace_path: plan.instancePaths.workspacePath
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
  const moltnetSummary = createMoltnetSummary(options.moltnet);

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
    runtimeInstances
  });
  const distributionLabels = createDistributionImageLabels(
    projectSlug,
    distributionReport.compile_fingerprint
  );

  const files: EmittedFile[] = [
    ...createRootfsFiles(runtimePlans),
    ...(options.moltnet?.files ?? []),
    {
      content: `${JSON.stringify(distributionReport, null, 2)}\n`,
      path: DISTRIBUTION_REPORT_OUTPUT_FILE
    },
    {
      content: await renderDockerfile(runtimePlans, {
        distribution: {
          labels: distributionLabels,
          reportOutputFile: DISTRIBUTION_REPORT_OUTPUT_FILE
        },
        hasMoltnet: Boolean(options.moltnet),
        hasStagedMoltnetBinaries: options.hasStagedMoltnetBinaries,
        moltnetPublishedPorts: options.moltnet?.publishedPorts ?? [],
        persistentMountPaths: persistentMounts.map((mount) => mount.mount_path)
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
      ...(persistentMounts.length > 0 ? { persistent_mounts: persistentMounts } : {}),
      ...(workspaceResources.length > 0 ? { workspace_resources: workspaceResources } : {})
    }
  };
};
