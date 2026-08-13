import type { MoltnetMessage, MoltnetTeamChatLogger } from "./moltnetTeamChatTypes.js";
import type { ExchangeEndReason } from "./moltnetMemeticsExchange.js";

export type { MoltnetMessage, MoltnetTeamChatApiClient, MoltnetTeamChatLogger } from "./moltnetTeamChatTypes.js";
export type { ExchangeEndReason } from "./moltnetMemeticsExchange.js";

export interface MoltnetMemeticsConversationResult {
  /** Every agent-authored turn observed after the seed, in order (Eleanor's proposal, Sam's challenge, Eleanor's
   * close, and any further turns up to the target/quiet-timeout/overall timeout). */
  agentTurns: MoltnetMessage[];
  /** Why the exchange wait concluded: the target turn count was reached, a quiet period elapsed with no further
   * @mention waking anyone, or the overall timeout was hit. */
  endedReason: ExchangeEndReason;
  /** First message from Eleanor, kept for backward compatibility; see agentTurns for the full exchange. */
  eleanorReply: MoltnetMessage;
  /** First message from Sam, kept for backward compatibility; see agentTurns for the full exchange. */
  samReply: MoltnetMessage;
  seedMessageText: string;
  seedToken: string;
  transcript: MoltnetMessage[];
}

export interface RunMoltnetMemeticsE2EOptions {
  authProfileName?: string;
  baseUrl?: string;
  claudeCodeDirectory?: string;
  codexDirectory?: string;
  containerName?: string;
  dockerCommand?: string;
  envFilePath?: string;
  fixtureDirectory?: string;
  imageTag?: string;
  /** Keep the temporary compile working directory instead of removing it. */
  keepArtifacts?: boolean;
  keepImages?: boolean;
  logger?: MoltnetTeamChatLogger;
  outputDirectory?: string;
  pollIntervalMs?: number;
  /** Grace period after the last observed agent message before concluding no further reply is coming (nobody was
   * @mentioned to wake). Defaults to DEFAULT_QUIET_GRACE_MS (35s), longer than one grok turn (~20-25s), so a wake
   * already in flight is never torn down mid-generation. */
  quietGraceMs?: number;
  /** Directory the captured transcript/engine-log run folder is written to; created if missing, always kept. */
  runFolder?: string;
  /** Optional local runtime install package overrides passed through to
   * buildProject/compileProject (see
   * src/compiler/containerPackageOverrides.ts). Omit this to use the
   * published Daimon and Mneme releases. */
  runtimePackageOverrides?: Record<string, string>;
  seedToken?: string;
  syncAuth?: boolean;
  /** Number of agent turns to wait for before concluding the exchange is complete (proposal, challenge, close, and
   * a possible ack). Clamped up to MIN_TARGET_TURNS (3) so the close can never be truncated. Defaults to
   * DEFAULT_TARGET_TURNS (4). */
  targetTurns?: number;
  timeoutMs?: number;
}

export interface RunMoltnetMemeticsE2EResult extends MoltnetMemeticsConversationResult {
  causalEventCounts: Record<string, number>;
  containerName: string;
  engineLogsCopied: boolean;
  imageTag: string;
  outputDirectory: string;
  runFolder: string;
}
