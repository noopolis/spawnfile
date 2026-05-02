import type { EmittedFile } from "../runtime/index.js";
import { getRuntimeAdapter } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import type {
  CompilePlan,
  ResolvedAgentNode,
  ResolvedTeamNode
} from "./types.js";
import { listConcreteMoltnetRoomMemberIds } from "./moltnetRoomMemberships.js";

export interface MoltnetServerPlan {
  id: string;
  name: string;
  networkId: string;
  port: number;
  rooms: Array<{
    id: string;
    members: string[];
  }>;
  teamSource: string;
}

export interface MoltnetBridgePlan {
  agentId: string;
  configPath: string;
  networkId: string;
  runtime: string;
}

export interface MoltnetArtifacts {
  bridgePlans: MoltnetBridgePlan[];
  files: EmittedFile[];
  ports: number[];
  publishedPorts: number[];
  serverPlans: MoltnetServerPlan[];
}

const DEFAULT_MOLTNET_PORT = 8787;
const DEFAULT_TINYCLAW_PORT = 3777;
const ROOTFS_PREFIX = "container/rootfs";
const INSTANCE_ROOT_PLACEHOLDER = "<instance-root>";
const CONFIG_FILE_PLACEHOLDER = "<config-file>";

const createServerKey = (networkId: string): string => networkId;

const createBridgeConfigPath = (teamSlug: string, networkId: string, agentId: string): string =>
  `${ROOTFS_PREFIX}/var/lib/spawnfile/moltnet/bridges/${teamSlug}-${networkId}-${agentId}.json`;

const resolveSequentialRuntimePort = (
  plan: CompilePlan,
  runtimeName: string,
  slug: string
): number | undefined => {
  const adapter = getRuntimeAdapter(runtimeName);
  const basePort = adapter.container.port;
  if (basePort === undefined) {
    return undefined;
  }

  const runtimeAgents = plan.nodes.filter(
    (node) => node.kind === "agent" && node.runtimeName === runtimeName
  );
  const index = runtimeAgents.findIndex((node) => node.slug === slug);
  if (index < 0) {
    return undefined;
  }

  return basePort + (index * (adapter.container.portStride ?? 1));
};

const createTinyClawChannel = (networkId: string, agentId: string): string =>
  `moltnet:${networkId}:${agentId}`;

const replaceContainerPathTemplate = (
  template: string,
  instanceRoot: string,
  configFileName: string
): string =>
  template
    .replaceAll(INSTANCE_ROOT_PLACEHOLDER, instanceRoot)
    .replaceAll(CONFIG_FILE_PLACEHOLDER, configFileName);

const resolveRuntimeInstancePaths = (
  runtimeName: string,
  slug: string
): { configPath: string; homePath?: string } => {
  const adapter = getRuntimeAdapter(runtimeName);
  const instanceRoot = `/var/lib/spawnfile/instances/${runtimeName}/agent-${slug}`;

  return {
    configPath: replaceContainerPathTemplate(
      adapter.container.instancePaths.configPathTemplate,
      instanceRoot,
      adapter.container.configFileName
    ),
    homePath: adapter.container.instancePaths.homePathTemplate
      ? replaceContainerPathTemplate(
          adapter.container.instancePaths.homePathTemplate,
          instanceRoot,
          adapter.container.configFileName
        )
      : undefined
  };
};

const resolveRuntimeConfig = (
  plan: CompilePlan,
  agentNode: ResolvedAgentNode,
  nodeSlug: string,
  networkId: string,
  agentId: string
): Record<string, string> => {
  switch (agentNode.runtime.name) {
    case "openclaw": {
      const port = resolveSequentialRuntimePort(plan, "openclaw", nodeSlug);
      if (!port) {
        throw new SpawnfileError(
          "compile_error",
          `Unable to resolve OpenClaw gateway port for Moltnet agent ${agentNode.name}`
        );
      }
      const instancePaths = resolveRuntimeInstancePaths("openclaw", nodeSlug);

      return {
        gateway_url: `ws://127.0.0.1:${port}`,
        ...(instancePaths.homePath ? { home_path: instancePaths.homePath } : {}),
        kind: "openclaw",
      };
    }
    case "picoclaw": {
      const instancePaths = resolveRuntimeInstancePaths("picoclaw", nodeSlug);

      return {
        command: "/usr/local/bin/picoclaw",
        config_path: instancePaths.configPath,
        ...(instancePaths.homePath ? { home_path: instancePaths.homePath } : {}),
        kind: "picoclaw",
      };
    }
    case "tinyclaw": {
      const channel = createTinyClawChannel(networkId, agentId);
      return {
        ack_url: `http://127.0.0.1:${DEFAULT_TINYCLAW_PORT}/api/responses`,
        channel,
        inbound_url: `http://127.0.0.1:${DEFAULT_TINYCLAW_PORT}/api/message`,
        kind: "tinyclaw",
        outbound_url:
          `http://127.0.0.1:${DEFAULT_TINYCLAW_PORT}/api/responses/pending?channel=${encodeURIComponent(channel)}`
      };
    }
    default:
      throw new SpawnfileError(
        "compile_error",
        `Moltnet does not know how to attach runtime ${agentNode.runtime.name} directly`
      );
  }
};

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
      const serverKey = createServerKey(network.id);
      const existingPlan = serverPlans.get(serverKey);
      if (existingPlan) {
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
              members: concreteMembers
            });
          }
        }
        existingPlan.rooms.sort((left, right) => left.id.localeCompare(right.id));
      } else {
        serverPlans.set(serverKey, {
          id: `${teamNode.slug}-${network.id}`,
          name: network.name,
          networkId: network.id,
          port: nextPort,
          rooms: network.rooms.map((room) => ({
            id: room.id,
            members: listConcreteMoltnetRoomMemberIds(
              plan,
              teamNode.value,
              network.id,
              room
            )
          })),
          teamSource: teamNode.value.source
        });
        nextPort += 1;
      }
    }
  }

  const bridgePlans: MoltnetBridgePlan[] = [];
  const bridgePlanKeys = new Set<string>();
  const configFiles: EmittedFile[] = [];

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

      const configPath = createBridgeConfigPath(
        teamNode.slug,
        attachment.network,
        attachment.memberId
      );
      const bridgePlanKey = `${attachment.network}::${attachment.memberId}`;
      if (bridgePlanKeys.has(bridgePlanKey)) {
        throw new SpawnfileError(
          "validation_error",
          `Duplicate Moltnet bridge attachment for ${attachment.network}/${attachment.memberId}`
        );
      }
      bridgePlanKeys.add(bridgePlanKey);

      configFiles.push({
        content:
          `${JSON.stringify(
            {
              version: "moltnet.bridge.v1",
              agent: {
                id: attachment.memberId,
                name: agentNode.name
              },
              moltnet: {
                base_url: `http://127.0.0.1:${serverPlan.port}`,
                network_id: attachment.network
              },
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
            },
            null,
            2
          )}\n`,
        mode: 0o600,
        path: configPath
      });

      bridgePlans.push({
        agentId: attachment.memberId,
        configPath: `/${configPath.replace(`${ROOTFS_PREFIX}/`, "")}`,
        networkId: attachment.network,
        runtime: agentNode.runtime.name
      });
    }
  }

  return {
    bridgePlans: bridgePlans.sort((left, right) => left.configPath.localeCompare(right.configPath)),
    files: configFiles,
    ports: [...new Set([...serverPlans.values()].map((plan) => plan.port))].sort((left, right) => left - right),
    publishedPorts: [
      ...new Set(
        teamNodes
          .flatMap((teamNode) =>
            (teamNode.value.networks ?? []).map((network) =>
              network.expose
                ? serverPlans.get(createServerKey(network.id))?.port
                : undefined
            )
          )
          .filter((port): port is number => port !== undefined)
      )
    ].sort((left, right) => left - right),
    serverPlans: [...serverPlans.values()].sort((left, right) => left.port - right.port)
  };
};
