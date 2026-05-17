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
    read?: "all" | "mentions" | "thread_only";
    reply?: "auto" | "never";
  };
  member_id: string;
  network_id: string;
  runtime: string;
  rooms?: Array<{
    id: string;
    read?: "all" | "mentions" | "thread_only";
    reply?: "auto" | "never";
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
  attachment: ResolvedMoltnetAttachment
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
    attachment.memberId
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
            ...(attachment.dms.read ? { read: attachment.dms.read } : {}),
            ...(attachment.dms.reply ? { reply: attachment.dms.reply } : {})
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
                ...(policy.read ? { read: policy.read } : {}),
                ...(policy.reply ? { reply: policy.reply } : {})
              };
            })
        }
      : {})
  };
};

export const resolveMoltnetWorkspaceLayout = (
  runtimeName: string,
  agentName: string
): MoltnetWorkspaceLayout => {
  if (runtimeName === "openclaw" || runtimeName === "picoclaw") {
    return {
      clientConfigPath: `workspace/${GENERATED_CONFIG_PATH}`,
      cliRuntime: runtimeName,
      skillPaths: [`workspace/skills/${GENERATED_SKILL_NAME}/SKILL.md`],
      workspaceRootPath: "workspace"
    };
  }

  if (runtimeName === "tinyclaw") {
    return {
      clientConfigPath: `workspace/${agentName}/${GENERATED_CONFIG_PATH}`,
      cliRuntime: runtimeName,
      skillPaths: [
        `workspace/${agentName}/.agents/skills/${GENERATED_SKILL_NAME}/SKILL.md`,
        `workspace/${agentName}/.claude/skills/${GENERATED_SKILL_NAME}/SKILL.md`
      ],
      workspaceRootPath: `workspace/${agentName}`
    };
  }

  throw new SpawnfileError(
    "compile_error",
    `Moltnet client config does not know how to emit files for runtime ${runtimeName}`
  );
};

export const createMoltnetClientConfigFiles = (
  node: ResolvedAgentNode,
  artifacts: MoltnetArtifacts
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
        attachments.map((attachment) => createAttachmentConfig(node, artifacts, attachment))
      ),
      path: layout.clientConfigPath
    }
  ];
};
