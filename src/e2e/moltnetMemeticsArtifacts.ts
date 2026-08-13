import type { MoltnetMessage } from "./moltnetMemeticsTypes.js";
import { copyContainerPathToHost, countJsonlLines } from "./moltnetArtifactSupport.js";

// copyContainerPathToHost/countJsonlLines moved verbatim to moltnetArtifactSupport.ts (a generic module reused by
// officeSim.ts). Re-exported here — a single definition, re-imported — so this file's existing exports and tests
// keep working unchanged.
export { copyContainerPathToHost, countJsonlLines };

const AGENT_NODE_ID_PREFIX = "agent:";

/** Strips the compiler's `agent:` node-id prefix down to the generated runtime slug. */
export const agentSlugFromNodeId = (nodeId: string): string =>
  nodeId.startsWith(AGENT_NODE_ID_PREFIX) ? nodeId.slice(AGENT_NODE_ID_PREFIX.length) : nodeId;

/** The generated Pi/Daimon instance root is the parent of its `home_path`. */
export const resolveInstanceRoot = (homePath: string): string => {
  const trimmed = homePath.endsWith("/") ? homePath.slice(0, -1) : homePath;
  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash <= 0 ? trimmed : trimmed.slice(0, lastSlash);
};

const textOf = (message: MoltnetMessage): string => message.parts.map((part) => part.text ?? "").join("\n");

export const serializeMemeticsTranscriptJsonl = (messages: MoltnetMessage[]): string =>
  messages.map((message) => JSON.stringify(message)).join("\n") + (messages.length > 0 ? "\n" : "");

export const renderMemeticsTranscriptMarkdown = (
  messages: MoltnetMessage[],
  options: { roomId: string; seedToken?: string } = { roomId: "eleanor-home" }
): string => {
  const lines = [
    `# Moltnet Memetics Transcript: ${options.roomId}`,
    "",
    ...(options.seedToken ? [`Seed token: \`${options.seedToken}\``, ""] : [])
  ];
  for (const message of messages) {
    const body = textOf(message).trim();
    lines.push(`## ${message.from.id} (${message.from.type})`, "", body.length > 0 ? body : "_(empty message)_", "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
};
