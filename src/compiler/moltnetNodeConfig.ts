import type { TeamNetworkServer } from "../manifest/index.js";
import type { RuntimeMoltnetBridgeConfig } from "../runtime/index.js";

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
  runtime: RuntimeMoltnetBridgeConfig;
}

const resolveMoltnetConnection = ({
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
}) => {
  const clientAuth = resolveMoltnetClientAuth(
    networkServer,
    attachment.network,
    attachment.memberId,
    nodeSlug,
    attachment.auth?.tokenId,
    agentNode.runtime.name
  );
  const usesPerAttachmentOpenToken =
    clientAuth.mode === "open" &&
    clientAuth.staticToken !== true &&
    Boolean(clientAuth.tokenEnv || clientAuth.tokenPath);

  const runtime = resolveRuntimeConfig(plan, agentNode, nodeSlug, attachment.network, attachment.memberId);
  return {
    clientAuth,
    usesPerAttachmentOpenToken,
    runtime,
    moltnet: {
      base_url: serverPlan.baseUrl,
      network_id: attachment.network,
      ...(clientAuth.mode === "none" ? {} : { auth_mode: clientAuth.mode }),
      ...(clientAuth.registration ? { registration: clientAuth.registration } : {}),
      ...(clientAuth.staticToken ? { static_token: true } : {})
    },
    credentials: {
      ...(clientAuth.tokenEnv ? { token_env: clientAuth.tokenEnv } : {}),
      ...(clientAuth.tokenPath ? { token_path: clientAuth.tokenPath } : {})
    },
    agentAttachment: {
      agent: {
        id: attachment.memberId,
        name: agentNode.name
      },
      runtime,
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
                  ...(policy.wake ? { wake: policy.wake } : {})
                };
              })
          }
        : {}),
      ...(attachment.dms
        ? {
            dms: {
              enabled: attachment.dms.enabled,
              ...(attachment.dms.wake ? { wake: attachment.dms.wake } : {}),
              ...(attachment.dms.allowedWakeSenders !== undefined
                ? {
                    allowed_wake_senders: [...attachment.dms.allowedWakeSenders]
                  }
                : {})
            }
          }
        : {})
    }
  };
};

type MoltnetConnectionInput = Parameters<typeof resolveMoltnetConnection>[0];

export const createMoltnetNodeConfigContent = (input: MoltnetConnectionInput): MoltnetNodeConfigResult => {
  const { clientAuth, usesPerAttachmentOpenToken, runtime, moltnet, credentials, agentAttachment } =
    resolveMoltnetConnection(input);
  const { agent, ...attachment } = agentAttachment;
  return {
    clientAuth,
    runtime,
    usesPerAttachmentOpenToken,
    content: `${JSON.stringify({
      version: "moltnet.node.v1",
      moltnet: { ...moltnet, ...(!usesPerAttachmentOpenToken ? credentials : {}) },
      attachments: [{
        agent,
        ...(usesPerAttachmentOpenToken ? { moltnet: credentials } : {}),
        ...attachment
      }]
    }, null, 2)}\n`
  };
};

/** Render the same attachment for the standalone Moltnet bridge command. */
export const createMoltnetBridgeConfigContent = (input: MoltnetConnectionInput): string => {
  const { moltnet, credentials, agentAttachment: { agent, ...attachment } } = resolveMoltnetConnection(input);
  return `${JSON.stringify({
    version: "moltnet.bridge.v1",
    agent,
    moltnet: { ...moltnet, ...credentials },
    ...attachment
  }, null, 2)}\n`;
};
