import type { TeamNetworkServer } from "../manifest/index.js";

import { resolveMoltnetClientAuth, type MoltnetClientAuthPlan } from "./moltnetConfigLowering.js";
import { resolveRuntimeConfig } from "./moltnetRuntimeConfig.js";
import type {
  CompilePlan,
  ResolvedAgentNode,
  ResolvedMoltnetAttachment
} from "./types.js";

interface MoltnetNodeConfigServerPlan {
  baseUrl: string;
  rooms: Array<{
    id: string;
    visibility?: "public" | "private";
    write_policy?: "members" | "operators" | "registered_agents";
  }>;
}

export interface MoltnetNodeConfigResult {
  clientAuth: MoltnetClientAuthPlan;
  content: string;
  usesPerAttachmentOpenToken: boolean;
}

export const createMoltnetNodeConfigContent = ({
  agentNode,
  attachment,
  networkServer,
  nodeSlug,
  plan,
  serverPlan
}: {
  agentNode: ResolvedAgentNode;
  attachment: ResolvedMoltnetAttachment & { memberId: string };
  networkServer: TeamNetworkServer;
  nodeSlug: string;
  plan: CompilePlan;
  serverPlan: MoltnetNodeConfigServerPlan;
}): MoltnetNodeConfigResult => {
  const clientAuth = resolveMoltnetClientAuth(
    networkServer,
    attachment.network,
    attachment.memberId,
    nodeSlug
  );
  const usesPerAttachmentOpenToken =
    clientAuth.mode === "open" &&
    clientAuth.staticToken !== true &&
    Boolean(clientAuth.tokenEnv || clientAuth.tokenPath);

  return {
    clientAuth,
    content:
      `${JSON.stringify(
        {
          version: "moltnet.node.v1",
          moltnet: {
            base_url: serverPlan.baseUrl,
            network_id: attachment.network,
            ...(clientAuth.mode === "none" ? {} : { auth_mode: clientAuth.mode }),
            ...(clientAuth.registration ? { registration: clientAuth.registration } : {}),
            ...(clientAuth.staticToken ? { static_token: true } : {}),
            ...(!usesPerAttachmentOpenToken && clientAuth.tokenEnv
              ? { token_env: clientAuth.tokenEnv }
              : {}),
            ...(!usesPerAttachmentOpenToken && clientAuth.tokenPath
              ? { token_path: clientAuth.tokenPath }
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
                nodeSlug,
                attachment.network,
                attachment.memberId
              ),
              ...(attachment.rooms
                ? {
                    rooms: Object.entries(attachment.rooms)
                      .sort(([left], [right]) => left.localeCompare(right))
                      .map(([roomId, policy]) => {
                        const room = serverPlan.rooms.find((entry) => entry.id === roomId);
                        return {
                          id: roomId,
                          ...(room?.visibility ? { visibility: room.visibility } : {}),
                          ...(room?.write_policy ? { write_policy: room.write_policy } : {}),
                          ...(policy.read ? { read: policy.read } : {}),
                          ...(policy.reply ? { reply: policy.reply } : {})
                        };
                      })
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
    usesPerAttachmentOpenToken
  };
};
