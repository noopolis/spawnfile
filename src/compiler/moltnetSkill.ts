import path from "node:path";
import { readFileSync } from "node:fs";

import type { EmittedFile } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import type { MoltnetArtifacts, MoltnetServerPlan } from "./moltnetArtifacts.js";
import type { ResolvedAgentNode, ResolvedMoltnetAttachment } from "./types.js";

const GENERATED_SKILL_NAME = "moltnet";
const GENERATED_CONFIG_PATH = ".moltnet/config.json";
const SKILL_SOURCE_PATH = path.resolve(
  process.cwd(),
  "moltnet",
  "internal",
  "skills",
  "moltnet",
  "SKILL.md"
);

interface MoltnetSkillAttachmentConfig {
  agent_name: string;
  auth: {
    mode: "none";
  };
  base_url: string;
  dms?: {
    enabled: boolean;
    read?: "all" | "mentions" | "thread_only";
    reply?: "auto" | "manual" | "never";
  };
  member_id: string;
  network_id: string;
  runtime: string;
  rooms?: Array<{
    id: string;
    read?: "all" | "mentions" | "thread_only";
    reply?: "auto" | "manual" | "never";
  }>;
}

const createSkillContent = (): string => readFileSync(SKILL_SOURCE_PATH, "utf8");

const createConfigContent = (
  node: ResolvedAgentNode,
  attachments: MoltnetSkillAttachmentConfig[]
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
  const plan = artifacts.serverPlans.find(
    (serverPlan) =>
      serverPlan.networkId === attachment.network &&
      serverPlan.teamSource === attachment.teamSource
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
): MoltnetSkillAttachmentConfig => {
  if (!attachment.memberId) {
    throw new SpawnfileError(
      "compile_error",
      `Moltnet skill requires a resolved member id for ${node.name}`
    );
  }

  const serverPlan = findServerPlan(artifacts, attachment);
  return {
    agent_name: node.name,
    auth: { mode: "none" },
    base_url: `http://127.0.0.1:${serverPlan.port}`,
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
            .map(([roomId, policy]) => ({
              id: roomId,
              ...(policy.read ? { read: policy.read } : {}),
              ...(policy.reply ? { reply: policy.reply } : {})
            }))
        }
      : {})
  };
};

const createSkillFilesForRuntime = (
  runtimeName: string,
  agentName: string,
  skillContent: string,
  configContent: string
): EmittedFile[] => {
  if (runtimeName === "openclaw" || runtimeName === "picoclaw") {
    return [
      {
        content: skillContent,
        path: `workspace/skills/${GENERATED_SKILL_NAME}/SKILL.md`
      },
      {
        content: configContent,
        path: `workspace/${GENERATED_CONFIG_PATH}`
      }
    ];
  }

  if (runtimeName === "tinyclaw") {
    return [
      {
        content: skillContent,
        path: `workspace/${agentName}/.agents/skills/${GENERATED_SKILL_NAME}/SKILL.md`
      },
      {
        content: skillContent,
        path: `workspace/${agentName}/.claude/skills/${GENERATED_SKILL_NAME}/SKILL.md`
      },
      {
        content: configContent,
        path: `workspace/${agentName}/${GENERATED_CONFIG_PATH}`
      }
    ];
  }

  throw new SpawnfileError(
    "compile_error",
    `Moltnet skill does not know how to emit files for runtime ${runtimeName}`
  );
};

export const createMoltnetSkillFiles = (
  node: ResolvedAgentNode,
  artifacts: MoltnetArtifacts
): EmittedFile[] => {
  const attachments = node.surfaces?.moltnet;
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const skillContent = createSkillContent();
  const configContent = createConfigContent(
    node,
    attachments.map((attachment) => createAttachmentConfig(node, artifacts, attachment))
  );

  return createSkillFilesForRuntime(node.runtime.name, node.name, skillContent, configContent);
};
