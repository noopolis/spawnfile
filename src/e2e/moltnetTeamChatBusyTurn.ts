import { randomUUID } from "node:crypto";

import { SpawnfileError } from "../shared/index.js";
import type { MoltnetTeamChatLogger, MoltnetMessage } from "./moltnetTeamChatTypes.js";
import { createMoltnetTeamChatB20BusyTurnBurst, type MoltnetTeamChatB20BusyTurnBurst } from "./moltnetTeamChatB20.js";

interface PollOptions {
  intervalMs: number;
  sleep: (delayMs: number) => Promise<void>;
  timeoutMs: number;
}
interface BusyTurnBurstClient {
  listRoomMessages(baseUrl: string, roomId: string, limit: number): Promise<MoltnetMessage[]>;
  sendRoomMessage(input: {
    baseUrl: string;
    from: { id: string; name?: string; type: string };
    mentions?: string[];
    roomId: string;
    text: string;
  }): Promise<void>;
}

export interface MoltnetTeamChatBusyTurnBurstResult {
  ackMessage: MoltnetMessage;
  burst: MoltnetTeamChatB20BusyTurnBurst;
}

const textOf = (message: MoltnetMessage): string =>
  message.parts.map((part) => part.text ?? "").join("\n");

const requiredBusyTurnTexts = (burst: MoltnetTeamChatB20BusyTurnBurst): string[] => [
  burst.responseSentinel,
  burst.step2Marker,
  burst.step3Marker
];

const busyTurnAckMessages = (
  messages: MoltnetMessage[],
  burst: MoltnetTeamChatB20BusyTurnBurst,
  authorId: string
): MoltnetMessage[] =>
  messages.filter((message) =>
    message.from.id === authorId && requiredBusyTurnTexts(burst).every((required) => textOf(message).includes(required))
  );

const poll = async <T>(description: string, options: PollOptions, attempt: () => Promise<T | null>): Promise<T> => {
  const attempts = Math.max(1, Math.ceil(options.timeoutMs / options.intervalMs));
  let lastError: unknown;
  for (let index = 0; index <= attempts; index += 1) {
    try {
      const result = await attempt();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await options.sleep(options.intervalMs);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new SpawnfileError("runtime_error", `${description} did not become ready${suffix}`);
};

const waitForSingleRoomMessage = (
  client: BusyTurnBurstClient,
  baseUrl: string,
  roomId: string,
  burst: MoltnetTeamChatB20BusyTurnBurst,
  authorId: string,
  options: PollOptions
): Promise<MoltnetMessage> =>
  poll(`Moltnet unique accumulated B20 ack from ${authorId}`, options, async () => {
    const matching = busyTurnAckMessages(await client.listRoomMessages(baseUrl, roomId, 50), burst, authorId);
    if (matching.length === 0) return null;
    if (matching.length === 1) return matching[0];
    throw new SpawnfileError("runtime_error", `Expected exactly one accumulated B20 ack from ${authorId}, but found ${matching.length}`);
  });

export const assertSingleBusyTurnAckMessage = async (
  client: BusyTurnBurstClient,
  baseUrl: string,
  roomId: string,
  burst: MoltnetTeamChatB20BusyTurnBurst,
  authorId: string
): Promise<MoltnetMessage> => {
  const matching = busyTurnAckMessages(await client.listRoomMessages(baseUrl, roomId, 100), burst, authorId);
  if (matching.length !== 1) {
    throw new SpawnfileError("runtime_error", `Expected exactly one accumulated B20 ack from ${authorId}, but found ${matching.length}`);
  }
  return matching[0];
};

export const sendBusyTurnBurstAndWaitForAck = async (
  client: BusyTurnBurstClient,
  parentBaseUrl: string,
  parentRoomId: string,
  parentAckAuthorId: string,
  logger: MoltnetTeamChatLogger,
  pollOptions: PollOptions
): Promise<MoltnetTeamChatBusyTurnBurstResult> => {
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const burst = createMoltnetTeamChatB20BusyTurnBurst({
    responseAuthorId: parentAckAuthorId,
    runId
  });
  logger.info("moltnet local_lab: sending busy-turn burst");
  for (const text of burst.texts) {
    await client.sendRoomMessage({
      baseUrl: parentBaseUrl,
      from: { id: "operator", name: "Moltnet E2E", type: "human" },
      mentions: [parentAckAuthorId],
      roomId: parentRoomId,
      text
    });
  }
  const ackMessage = await waitForSingleRoomMessage(
    client,
    parentBaseUrl,
    parentRoomId,
    burst,
    parentAckAuthorId,
    pollOptions
  );
  return { ackMessage, burst };
};
