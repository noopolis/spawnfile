import type { EmittedFile } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import { resolveMoltnetClientAuth } from "./moltnetConfigLowering.js";
import type { MoltnetArtifacts, MoltnetServerPlan } from "./moltnetArtifacts.js";
import type {
  ResolvedAgentNode,
  ResolvedMoltnetAttachment
} from "./types.js";

const GENERATED_SKILL_NAME = "moltnet";
const GENERATED_CONFIG_PATH = ".moltnet/config.json";

interface MoltnetClientAttachmentConfig {
  agent_name: string;
  auth: {
    mode: "bearer" | "none" | "open";
    registration?: "disabled" | "open" | "token";
    token_env?: string;
    token_path?: string;
  };
  base_url: string;
  dms?: {
    enabled: boolean;
    wake?: "all" | "mentions" | "thread_only" | "never";
  };
  member_id: string;
  network_id: string;
  runtime: string;
  rooms?: Array<{
    id: string;
    wake?: "all" | "mentions" | "thread_only" | "never";
    visibility?: "public" | "private";
    write_policy?: "members" | "operators" | "registered_agents";
  }>;
}

export interface MoltnetWorkspaceLayout {
  clientConfigPath: string;
  cliRuntime: string;
  skillPaths: string[];
  workspaceRootPath: string;
}

const createConfigContent = (
  node: ResolvedAgentNode,
  attachments: MoltnetClientAttachmentConfig[]
): string =>
  `${JSON.stringify(
    {
      version: "moltnet.client.v1",
      agent: {
        name: node.name,
        runtime: node.runtime.name
      },
      attachments
    },
    null,
    2
  )}\n`;

const findServerPlan = (
  artifacts: MoltnetArtifacts,
  attachment: ResolvedMoltnetAttachment
): MoltnetServerPlan => {
  const exactPlan = artifacts.serverPlans.find(
    (serverPlan) =>
      serverPlan.networkId === attachment.network &&
      serverPlan.teamSource === attachment.teamSource
  );
  const plan = exactPlan ?? artifacts.serverPlans.find(
    (serverPlan) => serverPlan.networkId === attachment.network
  );
  if (!plan) {
    throw new SpawnfileError(
      "compile_error",
      `Unable to resolve Moltnet server plan for ${attachment.network} on ${attachment.memberId ?? "unknown-agent"}`
    );
  }
  return plan;
};

const createAttachmentConfig = (
  node: ResolvedAgentNode,
  artifacts: MoltnetArtifacts,
  attachment: ResolvedMoltnetAttachment,
  agentSlug?: string
): MoltnetClientAttachmentConfig => {
  if (!attachment.memberId) {
    throw new SpawnfileError(
      "compile_error",
      `Moltnet client config requires a resolved member id for ${node.name}`
    );
  }

  const serverPlan = findServerPlan(artifacts, attachment);
  const auth = resolveMoltnetClientAuth(
    serverPlan.server,
    attachment.network,
    attachment.memberId,
    agentSlug
  );

  return {
    agent_name: node.name,
    auth: {
      mode: auth.mode,
      ...(auth.registration ? { registration: auth.registration } : {}),
      ...(auth.tokenEnv ? { token_env: auth.tokenEnv } : {}),
      ...(auth.tokenPath ? { token_path: auth.tokenPath } : {})
    },
    base_url: serverPlan.baseUrl,
    ...(attachment.dms
      ? {
          dms: {
            enabled: attachment.dms.enabled,
            ...(attachment.dms.wake ? { wake: attachment.dms.wake } : {})
          }
        }
      : {}),
    member_id: attachment.memberId,
    network_id: attachment.network,
    runtime: node.runtime.name,
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
      : {})
  };
};

export const resolveMoltnetWorkspaceLayout = (
  runtimeName: string,
  _agentName: string
): MoltnetWorkspaceLayout => {
  if (runtimeName === "openclaw" || runtimeName === "picoclaw") {
    return {
      clientConfigPath: `workspace/${GENERATED_CONFIG_PATH}`,
      cliRuntime: runtimeName,
      skillPaths: [`workspace/skills/${GENERATED_SKILL_NAME}/SKILL.md`],
      workspaceRootPath: "workspace"
    };
  }

  throw new SpawnfileError(
    "compile_error",
    `Moltnet client config does not know how to emit files for runtime ${runtimeName}`
  );
};

export const createMoltnetClientConfigFiles = (
  node: ResolvedAgentNode,
  artifacts: MoltnetArtifacts,
  agentSlug?: string
): EmittedFile[] => {
  const attachments = node.surfaces?.moltnet;
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const layout = resolveMoltnetWorkspaceLayout(node.runtime.name, node.name);
  return [
    {
      content: createConfigContent(
        node,
        attachments.map((attachment) =>
          createAttachmentConfig(node, artifacts, attachment, agentSlug)
        )
      ),
      path: layout.clientConfigPath
    }
  ];
};
