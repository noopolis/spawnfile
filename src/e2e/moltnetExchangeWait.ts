import type { MoltnetRoomTarget } from "./moltnetE2ESupport.js";
import type { MoltnetApiClient, MoltnetE2ELogger, MoltnetMessage } from "./moltnetWireTypes.js";

/** Minimum viable target turn count: a reply, a challenge, and a close. Lower values can truncate the close. */
export const MIN_TARGET_TURNS = 3;
/** Default target: propose, challenge, close, and a possible short ack. */
export const DEFAULT_TARGET_TURNS = 4;
/** Longer than one grok turn (~20-25s) so we do not tear down mid-wake. */
export const DEFAULT_QUIET_GRACE_MS = 35_000;

export type ExchangeEndReason = "turn-cap" | "quiet-timeout" | "timeout";

/** Clamps a requested target turn count so the close (seed -> reply -> challenge -> close) can never be truncated. */
export const resolveTargetTurns = (targetTurns?: number): number =>
  Math.max(MIN_TARGET_TURNS, targetTurns ?? DEFAULT_TARGET_TURNS);

export interface ExchangeCompletionInput {
  agentTurnCount: number;
  elapsedSinceLastAgentMessageMs: number;
  elapsedSinceStartMs: number;
  quietGraceMs: number;
  targetTurns: number;
  timeoutMs: number;
}
export interface ExchangeCompletionResult {
  done: boolean;
  reason: ExchangeEndReason | null;
}

/**
 * Pure stop/continue decision for the multi-turn exchange wait, isolated from network polling so it is unit
 * testable without fake timers. Stops when:
 *  - the target turn count is reached ("turn-cap"), or
 *  - at least one agent turn has been observed and a quiet period has elapsed since the last one, meaning nobody
 *    was @mentioned to wake the next agent ("quiet-timeout"), or
 *  - the overall timeout is hit regardless of turn count ("timeout").
 * Order matters: turn-cap is checked before quiet-timeout so a cap reached exactly at the grace boundary still
 * reports as "turn-cap".
 */
export const evaluateExchangeCompletion = (input: ExchangeCompletionInput): ExchangeCompletionResult => {
  if (input.agentTurnCount >= input.targetTurns) return { done: true, reason: "turn-cap" };
  if (input.agentTurnCount > 0 && input.elapsedSinceLastAgentMessageMs >= input.quietGraceMs) {
    return { done: true, reason: "quiet-timeout" };
  }
  if (input.elapsedSinceStartMs >= input.timeoutMs) return { done: true, reason: "timeout" };
  return { done: false, reason: null };
};

export interface WaitForConversationExchangeOptions {
  /** Ids treated as conversation participants; a message from any other id (e.g. the operator seed) is ignored. */
  agentIds: readonly string[];
  intervalMs: number;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
  quietGraceMs: number;
  sleep: (delayMs: number) => Promise<void>;
  targetTurns: number;
  timeoutMs: number;
}
export interface ConversationExchangeResult {
  agentTurns: MoltnetMessage[];
  endedReason: ExchangeEndReason;
  transcript: MoltnetMessage[];
}

/**
 * Drives/observes the room until the exchange is complete per evaluateExchangeCompletion, instead of stopping the
 * instant exactly two replies have been seen. Every newly observed agent message resets the quiet-period clock, so
 * a wake already in flight always gets its full grace period before teardown is allowed to proceed.
 */
export const waitForConversationExchange = async (
  apiClient: MoltnetApiClient,
  target: MoltnetRoomTarget,
  baselineIds: ReadonlySet<string>,
  options: WaitForConversationExchangeOptions,
  logger: MoltnetE2ELogger
): Promise<ConversationExchangeResult> => {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const seenIds = new Set(baselineIds);
  const agentTurns: MoltnetMessage[] = [];
  let lastAgentMessageAt = startedAt;
  let transcript: MoltnetMessage[] = [];

  for (;;) {
    transcript = await apiClient.listRoomMessages(target.baseUrl, target.roomId, 200);
    for (const message of transcript) {
      if (seenIds.has(message.id)) continue;
      seenIds.add(message.id);
      if (options.agentIds.includes(message.from.id)) {
        agentTurns.push(message);
        lastAgentMessageAt = now();
        logger.info(`moltnet ${target.networkId}: turn ${agentTurns.length} from ${message.from.id}`);
      }
    }

    const evaluation = evaluateExchangeCompletion({
      agentTurnCount: agentTurns.length,
      elapsedSinceLastAgentMessageMs: now() - lastAgentMessageAt,
      elapsedSinceStartMs: now() - startedAt,
      quietGraceMs: options.quietGraceMs,
      targetTurns: options.targetTurns,
      timeoutMs: options.timeoutMs
    });
    if (evaluation.done) return { agentTurns, endedReason: evaluation.reason as ExchangeEndReason, transcript };

    await options.sleep(options.intervalMs);
  }
};
