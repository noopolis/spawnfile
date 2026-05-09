import type { EmittedFile } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";
import type { TeamNetworkServer } from "../manifest/index.js";

import {
  createMoltnetNativeServerConfig,
  createMoltnetNodeConfigPath,
  createMoltnetServerConfigPath,
  resolveMoltnetBaseUrl,
  resolveMoltnetClientAuth,
  type MoltnetSecretPatch
} from "./moltnetConfigLowering.js";
import type { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";
import { listConcreteMoltnetRoomMemberIds } from "./moltnetRoomMemberships.js";
import { resolveRuntimeConfig } from "./moltnetRuntimeConfig.js";

export interface MoltnetServerPlan {
  baseUrl: string;
  configPath?: string;
  id: string;
  mode: "external" | "managed";
  name: string;
  networkId: string;
  port?: number;
  rooms: Array<{
    id: string;
    members: string[];
    name?: string;
  }>;
  server: TeamNetworkServer;
  secretPatches: MoltnetSecretPatch[];
  teamSource: string;
}

export interface MoltnetNodePlan {
  configPath: string;
  networkId: string;
}

export interface MoltnetArtifacts {
  files: EmittedFile[];
  nodePlans: MoltnetNodePlan[];
  ports: number[];
  publishedPorts: number[];
  serverPlans: MoltnetServerPlan[];
}

const DEFAULT_MOLTNET_PORT = 8787;
const ROOTFS_PREFIX = "container/rootfs";

const createServerKey = (networkId: string): string => networkId;

const toContainerRootfsPath = (rootfsPath: string): string =>
  `/${rootfsPath.replace(`${ROOTFS_PREFIX}/`, "")}`;

const isNetworkHttpEnabled = (
  network: NonNullable<ResolvedTeamNode["networks"]>[number]
): boolean => network.server?.mode === "managed" && network.server.human_ingress === true;

const resolveNetworkPort = (
  network: NonNullable<ResolvedTeamNode["networks"]>[number],
  fallbackPort: number
): number =>
  network.server?.mode === "managed" ? network.server.listen.port : fallbackPort;

export const generateMoltnetArtifacts = async (
  plan: CompilePlan
): Promise<MoltnetArtifacts | null> => {
  const teamNodes = plan.nodes
    .filter((node): node is typeof node & { value: ResolvedTeamNode } => node.kind === "team")
    .filter((node) => (node.value.networks?.length ?? 0) > 0);

  if (teamNodes.length === 0) {
    return null;
  }

  const serverPlans = new Map<string, MoltnetServerPlan>();
  let nextPort = DEFAULT_MOLTNET_PORT;

  for (const teamNode of teamNodes) {
    for (const network of teamNode.value.networks ?? []) {
      const server = network.server;
      if (!server) {
        throw new SpawnfileError(
          "validation_error",
          `Moltnet network ${network.id} must declare server`
        );
      }

      const serverKey = createServerKey(network.id);
      const existingPlan = serverPlans.get(serverKey);
      if (existingPlan) {
        if (existingPlan.baseUrl !== resolveMoltnetBaseUrl(server)) {
          throw new SpawnfileError(
            "validation_error",
            `Duplicate Moltnet network ${network.id} declares conflicting server URL`
          );
        }

        for (const room of network.rooms) {
          const concreteMembers = listConcreteMoltnetRoomMemberIds(
            plan,
            teamNode.value,
            network.id,
            room
          );
          const existingRoom = existingPlan.rooms.find((entry) => entry.id === room.id);
          if (existingRoom) {
            existingRoom.members = [
              ...new Set([...existingRoom.members, ...concreteMembers])
            ].sort();
          } else {
            existingPlan.rooms.push({
              id: room.id,
              members: concreteMembers,
              ...(room.name ? { name: room.name } : {})
            });
          }
        }
        existingPlan.rooms.sort((left, right) => left.id.localeCompare(right.id));
      } else {
        const port = server.mode === "managed" ? resolveNetworkPort(network, nextPort) : undefined;
        const serverId = `${teamNode.slug}-${network.id}`;
        serverPlans.set(serverKey, {
          baseUrl: resolveMoltnetBaseUrl(server),
          ...(server.mode === "managed"
            ? { configPath: toContainerRootfsPath(createMoltnetServerConfigPath(serverId)) }
            : {}),
          id: serverId,
          mode: server.mode,
          name: network.name,
          networkId: network.id,
          ...(port ? { port } : {}),
          rooms: network.rooms.map((room) => ({
            id: room.id,
            members: listConcreteMoltnetRoomMemberIds(
              plan,
              teamNode.value,
              network.id,
              room
            ),
            ...(room.name ? { name: room.name } : {})
          })),
          server,
          secretPatches: [],
          teamSource: teamNode.value.source
        });
        if (port) {
          nextPort = Math.max(nextPort, port + 1);
        }
      }
    }
  }

  const nodePlans: MoltnetNodePlan[] = [];
  const nodePlanKeys = new Set<string>();
  const configFiles: EmittedFile[] = [];

  for (const teamNode of teamNodes) {
    for (const network of teamNode.value.networks ?? []) {
      const serverPlan = serverPlans.get(createServerKey(network.id));
      if (!serverPlan || !network.server || network.server.mode !== "managed" || !serverPlan.configPath) {
        continue;
      }

      const native = createMoltnetNativeServerConfig({
        networkId: network.id,
        networkName: network.name,
        rooms: serverPlan.rooms,
        server: network.server
      });
      serverPlan.secretPatches = native.secretPatches;
      configFiles.push({
        content: `${JSON.stringify(native.config, null, 2)}\n`,
        mode: 0o600,
        path: createMoltnetServerConfigPath(serverPlan.id)
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

      if (network.server?.mode === "managed" && network.server.direct_messages === false && attachment.dms) {
        throw new SpawnfileError(
          "validation_error",
          `Moltnet network ${attachment.network} disables direct messages but ${agentNode.name} declares dms`
        );
      }

      if (!network.server) {
        throw new SpawnfileError(
          "validation_error",
          `Moltnet network ${attachment.network} must declare server`
        );
      }

      const configPath = createMoltnetNodeConfigPath(
        teamNode.slug,
        attachment.network,
        attachment.memberId
      );
      const nodePlanKey = `${attachment.network}::${attachment.memberId}`;
      if (nodePlanKeys.has(nodePlanKey)) {
        throw new SpawnfileError(
          "validation_error",
          `Duplicate Moltnet node attachment for ${attachment.network}/${attachment.memberId}`
        );
      }
      nodePlanKeys.add(nodePlanKey);

      const clientAuth = resolveMoltnetClientAuth(
        network.server,
        attachment.network,
        attachment.memberId
      );
      const usesPerAttachmentOpenToken =
        clientAuth.mode === "open" &&
        clientAuth.staticToken !== true &&
        Boolean(clientAuth.tokenEnv || clientAuth.tokenPath);

      configFiles.push({
        content:
          `${JSON.stringify(
            {
              version: "moltnet.node.v1",
              moltnet: {
                base_url: serverPlan.baseUrl,
                network_id: attachment.network,
                auth_mode: clientAuth.mode,
                ...(clientAuth.staticToken
                  ? { static_token: true }
                  : {}),
                ...(!usesPerAttachmentOpenToken && clientAuth.tokenEnv
                  ? {
                      token_env: clientAuth.tokenEnv
                    }
                  : {}),
                ...(!usesPerAttachmentOpenToken && clientAuth.tokenPath
                  ? {
                      token_path: clientAuth.tokenPath
                    }
                  : {})
              },
              attachments: [
                {
                  agent: {
                    id: attachment.memberId,
                    name: agentNode.name
                  },
                  ...(usesPerAttachmentOpenToken
                    ? {
                        moltnet: {
                          ...(clientAuth.tokenEnv ? { token_env: clientAuth.tokenEnv } : {}),
                          ...(clientAuth.tokenPath ? { token_path: clientAuth.tokenPath } : {})
                        }
                      }
                    : {}),
                  runtime: resolveRuntimeConfig(
                    plan,
                    agentNode,
                    node.slug,
                    attachment.network,
                    attachment.memberId
                  ),
                  ...(attachment.rooms
                    ? {
                        rooms: Object.entries(attachment.rooms)
                          .sort(([left], [right]) => left.localeCompare(right))
                          .map(([roomId, policy]) => ({
                            id: roomId,
                            ...(policy.read ? { read: policy.read } : {}),
                            ...(policy.reply ? { reply: policy.reply } : {})
                          }))
                      }
                    : {}),
                  ...(attachment.dms
                    ? {
                        dms: {
                          enabled: attachment.dms.enabled,
                          ...(attachment.dms.read ? { read: attachment.dms.read } : {}),
                          ...(attachment.dms.reply ? { reply: attachment.dms.reply } : {})
                        }
                      }
                    : {})
                }
              ]
            },
            null,
            2
          )}\n`,
        mode: 0o600,
        path: configPath
      });

      nodePlans.push({
        configPath: toContainerRootfsPath(configPath),
        networkId: attachment.network
      });
    }
  }

  const managedServerPlans = [...serverPlans.values()].filter(
    (serverPlan) => serverPlan.mode === "managed"
  );

  return {
    files: configFiles,
    nodePlans: nodePlans.sort((left, right) => left.configPath.localeCompare(right.configPath)),
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
