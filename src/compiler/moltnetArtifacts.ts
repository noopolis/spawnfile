import type { EmittedFile } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import type {
  CompilePlan,
  ResolvedAgentNode,
  ResolvedTeamNode
} from "./types.js";

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
  serverPlans: MoltnetServerPlan[];
}

const DEFAULT_MOLTNET_PORT = 8787;
const ROUTER_CONTROL_URL = "http://127.0.0.1:9100/team/message";
const ROOTFS_PREFIX = "container/rootfs";

const createServerKey = (teamSource: string, networkId: string): string =>
  `${teamSource}::${networkId}`;

const createBridgeConfigPath = (teamSlug: string, networkId: string, agentId: string): string =>
  `${ROOTFS_PREFIX}/var/lib/spawnfile/moltnet/bridges/${teamSlug}-${networkId}-${agentId}.json`;

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
      serverPlans.set(createServerKey(teamNode.value.source, network.id), {
        id: `${teamNode.slug}-${network.id}`,
        name: network.name,
        networkId: network.id,
        port: nextPort,
        rooms: network.rooms.map((room) => ({
          id: room.id,
          members: [...room.members]
        })),
        teamSource: teamNode.value.source
      });
      nextPort += 1;
    }
  }

  const bridgePlans: MoltnetBridgePlan[] = [];
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

      if (teamNode.value.auth) {
        throw new SpawnfileError(
          "validation_error",
          `Moltnet attachments do not yet support team.auth on team ${teamNode.value.name}`
        );
      }

      const serverPlan = serverPlans.get(createServerKey(attachment.teamSource, attachment.network));
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
              runtime: {
                kind: agentNode.runtime.name,
                control_url: ROUTER_CONTROL_URL
              },
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
    serverPlans: [...serverPlans.values()].sort((left, right) => left.port - right.port)
  };
};
