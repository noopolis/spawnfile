import type { MoltnetRoomTarget } from "./moltnetE2ESupport.js";
import type { MoltnetE2ELogger, MoltnetMessage } from "./moltnetWireTypes.js";

// The generic wire types (MoltnetE2ELogger/MoltnetTeamChatLogger, MoltnetRoom, MoltnetAgentSummary, MoltnetMessage,
// MoltnetApiClient/MoltnetTeamChatApiClient) live in moltnetWireTypes.ts now; re-exported here so existing imports
// of this module keep compiling.
export type {
  MoltnetAgentSummary,
  MoltnetApiClient,
  MoltnetE2ELogger,
  MoltnetMessage,
  MoltnetRoom,
  MoltnetTeamChatApiClient,
  MoltnetTeamChatLogger
} from "./moltnetWireTypes.js";

export interface MoltnetTeamChatScenario {
  child: MoltnetRoomTarget & { ackAuthorId: string; seedMentionId: string };
  fixtureDirectory: string;
  parent: MoltnetRoomTarget & { ackAuthorId: string; requestAuthorId: string; seedMentionId: string };
}
export interface MoltnetTeamChatConversationResult {
  busyTurnAckMessage: MoltnetMessage;
  childAckMessage: MoltnetMessage;
  parentAckMessage: MoltnetMessage;
  parentRequestMessage: MoltnetMessage;
  sentinels: {
    busyTurnAck: string;
    busyTurnStep2: string;
    busyTurnStep3: string;
    childAck: string;
    childRequest: string;
    parentAck: string;
    parentRequest: string;
  };
}
export interface RunMoltnetTeamChatE2EOptions {
  authProfileName?: string;
  childBaseUrl?: string;
  claudeCodeDirectory?: string;
  codexDirectory?: string;
  containerName?: string;
  dockerCommand?: string;
  envFilePath?: string;
  fixtureDirectory?: string;
  imageTag?: string;
  keepArtifacts?: boolean;
  keepImages?: boolean;
  logger?: MoltnetE2ELogger;
  outputDirectory?: string;
  parentBaseUrl?: string;
  pollIntervalMs?: number;
  syncAuth?: boolean;
  timeoutMs?: number;
}
export interface RunMoltnetTeamChatE2EResult extends MoltnetTeamChatConversationResult {
  containerName: string;
  imageTag: string;
  outputDirectory: string;
}
