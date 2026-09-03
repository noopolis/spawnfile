import type { EmittedFile } from "../runtime/index.js";
import { resolveNoopolisRunId } from "../runtime/index.js";
import { createExclusiveReattachVolumeName, SpawnfileError } from "../shared/index.js";

import {
  createMoltnetCausalDirectory,
  createMoltnetDaimonReceiptStorePath,
  createMoltnetNetworkStateDirectory,
  createMoltnetServerConfigPath,
  createMoltnetOpenTokenDirectory,
  createMoltnetNativeServerConfig,
  createMoltnetNodeConfigPath,
  resolveMoltnetClientAuth,
  resolveMoltnetStorePersistenceMountPath
} from "./moltnetConfigLowering.js";
import type { MoltnetArtifacts, MoltnetNodePlan, MoltnetPersistentMount, MoltnetServerPlan } from "./moltnetArtifactTypes.js";
import type { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";
import { assertNetworkBindingEnvUniqueness } from "./networkBinding.js";
import { createMoltnetNodeConfigContent } from "./moltnetNodeConfig.js";
import {
  createPersistentVolumeName,
  isNetworkHttpEnabled,
  toContainerRootfsPath
} from "./moltnetArtifactPaths.js";
import { createMoltnetExternalParticipantArtifactFiles } from "./moltnetExternalParticipantArtifact.js";
import { resolveMoltnetServerPlans } from "./moltnetServerPlans.js";

export type {
  MoltnetArtifacts,
  MoltnetNodePlan,
  MoltnetPersistentMount,
  MoltnetServerPlan
} from "./moltnetArtifactTypes.js";

const createServerKey = (networkId: string): string => networkId;

export const generateMoltnetArtifacts = async (
  plan: CompilePlan,
  deploymentLineage = "compile"
): Promise<MoltnetArtifacts | null> => {
  const teamNodes = plan.nodes
    .filter((node): node is typeof node & { value: ResolvedTeamNode } => node.kind === "team")
    .filter((node) => (node.value.networks?.length ?? 0) > 0);

  if (teamNodes.length === 0) {
    return null;
  }

  // Run-scoping key for the RUN-SCOPED mounts derived below — the causal
  // event log and per-network Moltnet runtime state (see
  // createPersistentVolumeName's doc comment). Read once per compile so every
  // such mount in this compile agrees on the same value. Durable stores and
  // token directories deliberately do NOT use it; see durableVolumeName.
  const runId = resolveNoopolisRunId(process.env);
  /**
   * Deployment-stable name for state that must be REATTACHED across a
   * redeploy, never recreated empty: durable Moltnet `sqlite`/`json` stores
   * and the open-mode agent token directories. An author-declared name
   * (`server.store.persistence.name`) is honoured verbatim so an operator can
   * pre-create or migrate the volume under that exact name; otherwise the
   * name comes from the plan root plus the deployment lineage, exactly as
   * durable memory banks are named (`memoryArtifacts.ts`'s
   * `durableMemoryVolumeName`).
   */
  const durableVolumeName = (mountId: string, declaredName?: string): string =>
    declaredName?.trim()
    || createExclusiveReattachVolumeName(`${plan.root}\0${deploymentLineage}`, mountId);

  const serverPlans = resolveMoltnetServerPlans(plan, teamNodes);

  const nodePlans: MoltnetNodePlan[] = [];
  const nodePlanKeys = new Set<string>();
  const configFiles: EmittedFile[] = [];
  const persistentMounts = new Map<string, MoltnetPersistentMount>();
  const external = createMoltnetExternalParticipantArtifactFiles(plan.moltnetExternalParticipantIntents ?? []);
  const receiptStoreOwners = new Map<string, string>();
  configFiles.push(...external.files);

  const addPersistentMount = (mount: MoltnetPersistentMount): void => {
    const existing = persistentMounts.get(mount.id);
    if (!existing) {
      persistentMounts.set(mount.id, mount);
      return;
    }

    if (
      existing.mountPath !== mount.mountPath ||
      existing.volumeName !== mount.volumeName ||
      existing.lifecycle !== mount.lifecycle
    ) {
      throw new SpawnfileError(
        "validation_error",
        `Moltnet persistent mount ${mount.id} resolves to conflicting targets`
      );
    }
  };

  for (const serverPlan of serverPlans.values()) {
    if (serverPlan.mode !== "managed" || serverPlan.server.mode !== "managed" || !serverPlan.configPath) {
      continue;
    }

    const native = createMoltnetNativeServerConfig({
      networkId: serverPlan.networkId,
      networkName: serverPlan.name,
      rooms: serverPlan.rooms,
      server: serverPlan.server
    });
    serverPlan.secretPatches = native.secretPatches;
    configFiles.push({
      content: `${JSON.stringify(native.config, null, 2)}\n`,
      mode: 0o600,
      path: createMoltnetServerConfigPath(serverPlan.id)
    });

    // Always mounted, independent of the network's store.kind/persistence:
    // this is the causal/social record (message.accepted/message.denied
    // events), the A5/memetics ground truth for what happened in a run, and
    // it must survive container teardown even for a purely in-memory
    // (non-durable) room store — e.g. office-sim's fixture. Lives in its own
    // `causal/` subdirectory, never the server config's own directory, so
    // this volume never shadows a rebuilt image's Moltnet.json.
    const causalMountId = `moltnet-${serverPlan.networkId}-causal`;
    addPersistentMount({
      id: causalMountId,
      mountPath: createMoltnetCausalDirectory(serverPlan.configPath),
      reason: `managed Moltnet causal event log for ${serverPlan.networkId}`,
      volumeName: createPersistentVolumeName(plan.root, causalMountId, runId)
    });

    const storeMountPath = resolveMoltnetStorePersistenceMountPath(
      serverPlan.networkId,
      serverPlan.server.store
    );
    if (storeMountPath) {
      const mountId = `moltnet-${serverPlan.networkId}-store`;
      const store = serverPlan.server.store;
      const explicitVolumeName = store.kind === "sqlite" || store.kind === "json"
        ? store.persistence?.name
        : undefined;
      addPersistentMount({
        id: mountId,
        lifecycle: "exclusive-reattach",
        mountPath: storeMountPath,
        reason: `managed Moltnet ${serverPlan.server.store.kind} store for ${serverPlan.networkId}`,
        volumeName: durableVolumeName(mountId, explicitVolumeName)
      });
    }
  }

  for (const node of plan.nodes) {
    if (node.kind !== "agent") {
      continue;
    }

    const agentNode = node.value as ResolvedAgentNode;
    if (!agentNode.surfaces?.moltnet || agentNode.surfaces.moltnet.length === 0) {
      continue;
    }

    for (const attachment of agentNode.surfaces.moltnet) {
      if (!attachment.teamSource || !attachment.memberId) {
        throw new SpawnfileError(
          "validation_error",
          `Agent ${agentNode.name} Moltnet attachments require a team-bound network context`
        );
      }

      const teamNode = teamNodes.find((team) => team.value.source === attachment.teamSource);
      if (!teamNode) {
        throw new SpawnfileError(
          "validation_error",
          `Unable to find team context for Moltnet attachment ${attachment.network} on ${agentNode.name}`
        );
      }

      const serverPlan = serverPlans.get(createServerKey(attachment.network));
      if (!serverPlan) {
        throw new SpawnfileError(
          "validation_error",
          `Unable to find Moltnet network ${attachment.network} for ${agentNode.name}`
        );
      }

      const network = teamNode.value.networks?.find((entry) => entry.id === attachment.network);
      if (!network) {
        throw new SpawnfileError(
          "validation_error",
          `Unable to find Moltnet network ${attachment.network} for ${agentNode.name}`
        );
      }

      if (
        serverPlan.server.mode === "managed" &&
        serverPlan.server.direct_messages === false &&
        attachment.dms
      ) {
        throw new SpawnfileError(
          "validation_error",
          `Moltnet network ${attachment.network} disables direct messages but ${agentNode.name} declares dms`
        );
      }

      const configPath = createMoltnetNodeConfigPath(
        teamNode.slug,
        attachment.network,
        attachment.memberId
      );
      const receiptStorePath = agentNode.runtime.name === "daimon"
        ? createMoltnetDaimonReceiptStorePath(attachment.network, attachment.memberId)
        : undefined;
      if (receiptStorePath) {
        const owner = `${attachment.network}\u0000${attachment.memberId}`;
        const existingOwner = receiptStoreOwners.get(receiptStorePath);
        if (existingOwner !== undefined && existingOwner !== owner) {
          throw new SpawnfileError("validation_error", "Daimon receipt-store paths collide");
        }
        receiptStoreOwners.set(receiptStorePath, owner);
        const networkRoot = createMoltnetNetworkStateDirectory(attachment.network);
        const covered = [...persistentMounts.values()].some((mount) =>
          networkRoot === mount.mountPath || networkRoot.startsWith(`${mount.mountPath}/`)
        );
        if (!covered) {
          const mountId = `moltnet-${attachment.network}-runtime-state`;
          addPersistentMount({ id: mountId, mountPath: networkRoot, reason: `Moltnet runtime state for ${attachment.network}`, volumeName: createPersistentVolumeName(plan.root, mountId, runId) });
        }
      }
      const nodePlanKey = `${attachment.network}::${attachment.memberId}`;
      if (nodePlanKeys.has(nodePlanKey)) {
        throw new SpawnfileError(
          "validation_error",
          `Duplicate Moltnet node attachment for ${attachment.network}/${attachment.memberId}`
        );
      }
      nodePlanKeys.add(nodePlanKey);

      if (agentNode.runtime.name === "pi") {
        const clientAuth = resolveMoltnetClientAuth(
          serverPlan.server,
          attachment.network,
          attachment.memberId,
          node.slug,
          attachment.auth?.tokenId
        );
        const usesPerAttachmentOpenToken =
          clientAuth.mode === "open" &&
          clientAuth.staticToken !== true &&
          Boolean(clientAuth.tokenEnv || clientAuth.tokenPath);

        if (usesPerAttachmentOpenToken && clientAuth.tokenPath) {
          const mountId = `agent-${node.slug}-moltnet-tokens`;
          addPersistentMount({
            id: mountId,
            lifecycle: "exclusive-reattach",
            mountPath: createMoltnetOpenTokenDirectory(node.slug),
            reason: `Moltnet open-mode generated agent tokens for ${agentNode.name}`,
            volumeName: durableVolumeName(mountId)
          });
        }
      }

      const nodeConfig = createMoltnetNodeConfigContent({
        agentNode,
        attachment: { ...attachment, memberId: attachment.memberId },
        networkServer: serverPlan.server,
        nodeSlug: node.slug,
        plan,
        serverPlan
      });
      const { clientAuth, usesPerAttachmentOpenToken } = nodeConfig;

      if (usesPerAttachmentOpenToken && clientAuth.tokenPath) {
        const mountId = `agent-${node.slug}-moltnet-tokens`;
        addPersistentMount({
          id: mountId,
          lifecycle: "exclusive-reattach",
          mountPath: createMoltnetOpenTokenDirectory(node.slug),
          reason: `Moltnet open-mode generated agent tokens for ${agentNode.name}`,
          volumeName: durableVolumeName(mountId)
        });
      }

      configFiles.push({
        content: nodeConfig.content,
        mode: 0o600,
        path: configPath
      });

      nodePlans.push({
        configPath: toContainerRootfsPath(configPath),
        ...(clientAuth.credentialAgentId
          ? { credentialAgentId: clientAuth.credentialAgentId }
          : {}),
        ...(clientAuth.credentialId ? { credentialId: clientAuth.credentialId } : {}),
        ...(clientAuth.tokenEnv ? { credentialSecret: clientAuth.tokenEnv } : {}),
        memberId: attachment.memberId,
        networkId: attachment.network,
        ...(receiptStorePath ? { receiptStorePath } : {})
      });
    }
  }

  const managedServerPlans = [...serverPlans.values()].filter(
    (serverPlan) => serverPlan.mode === "managed"
  );

  assertNetworkBindingEnvUniqueness(
    [...serverPlans.values()].map((serverPlan) => ({
      id: serverPlan.networkId,
      members: [...new Set(serverPlan.rooms.flatMap((room) => room.members))]
    }))
  );

  return {
    files: configFiles,
    ...(external.artifacts.length > 0
      ? { externalParticipantArtifacts: external.artifacts }
      : {}),
    nodePlans: nodePlans.sort((left, right) => left.configPath.localeCompare(right.configPath)),
    persistentMounts: [...persistentMounts.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
    ports: [...new Set(managedServerPlans.map((serverPlan) => serverPlan.port).filter((port): port is number => port !== undefined))].sort((left, right) => left - right),
    publishedPorts: [
      ...new Set(
        teamNodes
          .flatMap((teamNode) =>
            (teamNode.value.networks ?? []).map((network) =>
              isNetworkHttpEnabled(network)
                ? serverPlans.get(createServerKey(network.id))?.port
                : undefined
            )
          )
          .filter((port): port is number => port !== undefined)
      )
    ].sort((left, right) => left - right),
    serverPlans: [...serverPlans.values()].sort((left, right) =>
      (left.port ?? Number.MAX_SAFE_INTEGER) - (right.port ?? Number.MAX_SAFE_INTEGER)
      || left.networkId.localeCompare(right.networkId)
    )
  };
};
