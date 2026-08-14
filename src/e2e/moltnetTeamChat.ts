import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { requireAuthProfile } from "../auth/index.js";
import {
  buildProject,
  createDockerRunInvocation,
  runDockerContainer,
  syncProjectAuth,
  type BuildProjectResult,
  type DockerRunInvocation
} from "../compiler/index.js";
import { removeDirectory } from "../filesystem/index.js";
import { isSpawnfileError, SpawnfileError } from "../shared/index.js";
import { assertSingleBusyTurnAckMessage, sendBusyTurnBurstAndWaitForAck } from "./moltnetTeamChatBusyTurn.js";
import {
  assertExactRoomMembers,
  cleanup,
  createMoltnetHttpClient,
  formatHistory,
  healthPathForRuntime,
  poll,
  resolveAuthProfile,
  runDockerCommand,
  waitForAgents,
  waitForRoom,
  waitForRuntimeReadiness,
  type DockerCommandRunner,
  type MoltnetE2EDependencies,
  type MoltnetRoomTarget,
  type PollOptions
} from "./moltnetE2ESupport.js";
import type {
  MoltnetMessage,
  MoltnetRoom,
  MoltnetAgentSummary,
  MoltnetTeamChatApiClient,
  MoltnetTeamChatConversationResult,
  MoltnetTeamChatLogger,
  MoltnetTeamChatScenario,
  RunMoltnetTeamChatE2EOptions,
  RunMoltnetTeamChatE2EResult
} from "./moltnetTeamChatTypes.js";

const DEFAULT_FIXTURE_DIRECTORY = fileURLToPath(new URL("../../examples/moltnet-team-chat", import.meta.url));
const DEFAULT_PARENT_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_CHILD_BASE_URL = "http://127.0.0.1:8788";

export type { MoltnetTeamChatLogger } from "./moltnetTeamChatTypes.js";
export type {
  MoltnetMessage,
  MoltnetAgentSummary,
  MoltnetRoom,
  MoltnetTeamChatApiClient,
  MoltnetTeamChatConversationResult,
  MoltnetTeamChatScenario,
  RunMoltnetTeamChatE2EOptions,
  RunMoltnetTeamChatE2EResult
} from "./moltnetTeamChatTypes.js";

// The generic Docker/Moltnet boot+observe plumbing below (createMoltnetHttpClient, poll, waitForRoom,
// waitForAgents, waitForRuntimeReadiness, runDockerCommand, resolveAuthProfile, cleanup, formatHistory,
// healthPathForRuntime, assertExactRoomMembers, and the MoltnetRoomTarget/DockerCommandRunner/dependency-bag
// types) moved to moltnetE2ESupport.ts so officeSim.ts (and any future driver) can reuse it without depending on
// this team-chat-specific module. Re-exported here — a single definition, re-imported — so this file's own
// scenario logic below and any existing external imports of these names from this module keep working unchanged.
export {
  assertExactRoomMembers,
  cleanup,
  createMoltnetHttpClient,
  formatHistory,
  healthPathForRuntime,
  poll,
  resolveAuthProfile,
  runDockerCommand,
  waitForAgents,
  waitForRoom,
  waitForRuntimeReadiness
};
export type { DockerCommandRunner, MoltnetRoomTarget, PollOptions };
/** @deprecated Use MoltnetE2EDependencies from moltnetE2ESupport.ts. Kept so existing imports of the old name
 * (e.g. moltnetMemetics.ts) keep compiling. */
export type MoltnetTeamChatDependencies = MoltnetE2EDependencies;

const sleep = async (delayMs: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, delayMs); });
const loggerFor = (logger?: MoltnetTeamChatLogger): MoltnetTeamChatLogger => logger ?? { info: (message) => console.log(message) };

export const createMoltnetTeamChatScenario = (
  options: Pick<RunMoltnetTeamChatE2EOptions, "childBaseUrl" | "fixtureDirectory" | "parentBaseUrl"> = {}
): MoltnetTeamChatScenario => ({
  child: {
    ackAuthorId: "field-representative",
    baseUrl: options.childBaseUrl ?? DEFAULT_CHILD_BASE_URL,
    expectedMembers: ["field-observer", "field-representative"],
    networkId: "field_lab",
    roomId: "field-room",
    seedMentionId: "field-representative"
  },
  fixtureDirectory: options.fixtureDirectory ?? DEFAULT_FIXTURE_DIRECTORY,
  parent: {
    ackAuthorId: "field-representative",
    baseUrl: options.parentBaseUrl ?? DEFAULT_PARENT_BASE_URL,
    expectedMembers: ["analysis-representative", "coordinator", "field-representative"],
    networkId: "local_lab",
    requestAuthorId: "coordinator",
    roomId: "mission-control",
    seedMentionId: "coordinator"
  }
});

const textOf = (message: MoltnetMessage): string =>
  message.parts.map((part) => part.text ?? "").join("\n");
export const findRoomMessage = (
  messages: MoltnetMessage[],
  sentinel: string,
  authorId: string
): MoltnetMessage | undefined =>
  messages.find((message) => message.from.id === authorId && textOf(message).includes(sentinel));

export const waitForMessage = (client: MoltnetTeamChatApiClient, target: MoltnetRoomTarget, sentinel: string, authorId: string, options: PollOptions) =>
  poll(`Moltnet message ${sentinel} from ${authorId}`, options, async () =>
    findRoomMessage(await client.listRoomMessages(target.baseUrl, target.roomId, 50), sentinel, authorId) ?? null
  );

export const runMoltnetTeamChatConversation = async (
  scenario: MoltnetTeamChatScenario,
  options: { apiClient: MoltnetTeamChatApiClient; logger?: MoltnetTeamChatLogger; pollIntervalMs: number; sleep: (delayMs: number) => Promise<void>; timeoutMs: number }
): Promise<MoltnetTeamChatConversationResult> => {
  const logger = loggerFor(options.logger);
  const pollOptions = { intervalMs: options.pollIntervalMs, sleep: options.sleep, timeoutMs: options.timeoutMs };
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const sentinels = {
    busyTurnAck: "",
    busyTurnStep2: "",
    busyTurnStep3: "",
    childAck: `SF-MOLTNET-E2E-CHILD-ACK-${runId}`,
    childRequest: `SF-MOLTNET-E2E-CHILD-${runId}`,
    parentAck: `SF-MOLTNET-E2E-ACK-${runId}`,
    parentRequest: `SF-MOLTNET-E2E-REQUEST-${runId}`
  };

  for (const target of [scenario.parent, scenario.child]) {
    logger.info(`moltnet ${target.networkId}: waiting for health`);
    await poll(`Moltnet ${target.networkId} health`, pollOptions, async () => (await options.apiClient.health(target.baseUrl)) ? true : null);
    await waitForRoom(options.apiClient, target, pollOptions);
    await waitForAgents(options.apiClient, target, pollOptions);
  }

  const busyTurnBurstResult = await sendBusyTurnBurstAndWaitForAck(
    options.apiClient,
    scenario.parent.baseUrl,
    scenario.parent.roomId,
    scenario.parent.ackAuthorId,
    logger,
    pollOptions
  );
  sentinels.busyTurnAck = busyTurnBurstResult.burst.responseSentinel;
  sentinels.busyTurnStep2 = busyTurnBurstResult.burst.step2Marker;
  sentinels.busyTurnStep3 = busyTurnBurstResult.burst.step3Marker;
  const busyTurnAckMessage = busyTurnBurstResult.ackMessage;
  logger.info("moltnet local_lab: sending parent seed");
  await options.apiClient.sendRoomMessage({
    baseUrl: scenario.parent.baseUrl,
    from: { id: "operator", name: "Moltnet E2E", type: "human" },
    mentions: [scenario.parent.seedMentionId],
    roomId: scenario.parent.roomId,
    text: `SF-MOLTNET-E2E-SEED request=${sentinels.parentRequest} ack=${sentinels.parentAck}. Coordinator must send the request sentinel in ${scenario.parent.roomId}; field-representative must answer with the ack sentinel.`
  });
  const parentRequestMessage = await waitForMessage(options.apiClient, scenario.parent, sentinels.parentRequest, scenario.parent.requestAuthorId, pollOptions);
  const parentAckMessage = await waitForMessage(options.apiClient, scenario.parent, sentinels.parentAck, scenario.parent.ackAuthorId, pollOptions);

  logger.info("moltnet field_lab: sending child seed");
  await options.apiClient.sendRoomMessage({
    baseUrl: scenario.child.baseUrl,
    from: { id: "operator", name: "Moltnet E2E", type: "human" },
    mentions: [scenario.child.seedMentionId],
    roomId: scenario.child.roomId,
    text: `SF-MOLTNET-E2E-CHILD-SEED request=${sentinels.childRequest} ack=${sentinels.childAck}. field-representative must answer in ${scenario.child.roomId} with the child ack sentinel.`
  });
  const childAckMessage = await waitForMessage(options.apiClient, scenario.child, sentinels.childAck, scenario.child.ackAuthorId, pollOptions);
  await assertSingleBusyTurnAckMessage(
    options.apiClient,
    scenario.parent.baseUrl,
    scenario.parent.roomId,
    busyTurnBurstResult.burst,
    scenario.parent.ackAuthorId
  );
  return {
    busyTurnAckMessage,
    childAckMessage,
    parentAckMessage,
    parentRequestMessage,
    sentinels: { ...sentinels }
  };
};

/**
 * INTERIM live-model regression check (Slice B), kept intentionally: a real
 * busy-turn burst getting exactly one reply that carries every queued
 * marker (`assertSingleBusyTurnAckMessage`/`sendBusyTurnBurstAndWaitForAck`
 * in `moltnetTeamChatBusyTurn.ts`) is unfakeable live-model behavior — no
 * fake-engine unit test can stand in for it. Shared by `moltnetTeamChatB20.ts`
 * too. This stays in `src/e2e` as-is pending the compose-and-observe
 * pipeline (Spawnfile org + Simfile world, composed and run, observed
 * read-only from `simfile`); do not touch the shared plumbing
 * (`moltnetE2ESupport.ts`) while this is still the only thing exercising it.
 */
export const runMoltnetTeamChatE2E = async (options: RunMoltnetTeamChatE2EOptions = {}, dependencies: MoltnetTeamChatDependencies = {}): Promise<RunMoltnetTeamChatE2EResult> => {
  const deps = {
    apiClient: dependencies.apiClient ?? createMoltnetHttpClient(),
    buildProject: dependencies.buildProject ?? buildProject,
    createDockerRunInvocation: dependencies.createDockerRunInvocation ?? createDockerRunInvocation,
    removeDirectory: dependencies.removeDirectory ?? removeDirectory,
    requireAuthProfile: dependencies.requireAuthProfile ?? requireAuthProfile,
    runDockerCommand: dependencies.runDockerCommand ?? runDockerCommand,
    runDockerContainer: dependencies.runDockerContainer ?? runDockerContainer,
    sleep: dependencies.sleep ?? sleep,
    syncProjectAuth: dependencies.syncProjectAuth ?? syncProjectAuth
  };
  const logger = loggerFor(options.logger);
  const scenario = createMoltnetTeamChatScenario({
    childBaseUrl: options.childBaseUrl,
    fixtureDirectory: options.fixtureDirectory,
    parentBaseUrl: options.parentBaseUrl
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-e2e-moltnet-team-chat-"));
  const dockerCommand = options.dockerCommand ?? "docker";
  const outputDirectory = options.outputDirectory ?? path.join(root, "dist");
  const containerName = options.containerName ?? "spawnfile-e2e-moltnet-team-chat";
  let buildResult: BuildProjectResult | undefined;
  let invocation: DockerRunInvocation | undefined;

  try {
    logger.info("moltnet-team-chat: syncing auth");
    const authProfile = await resolveAuthProfile(scenario.fixtureDirectory, path.join(root, "spawnfile-home"), options, deps);
    logger.info("moltnet-team-chat: building image");
    buildResult = await deps.buildProject(scenario.fixtureDirectory, { dockerCommand, imageTag: options.imageTag ?? `spawnfile-e2e-moltnet-team-chat-${Date.now()}`, outputDirectory });
    invocation = await deps.createDockerRunInvocation(buildResult, buildResult.imageTag, { authProfile, containerName, detach: true, dockerCommand });
    logger.info(`moltnet-team-chat: starting container ${invocation.containerName ?? containerName}`);
    await deps.runDockerContainer(invocation);
    const pollOptions = { intervalMs: options.pollIntervalMs ?? 2_000, sleep: deps.sleep, timeoutMs: options.timeoutMs ?? 240_000 };
    await waitForRuntimeReadiness(buildResult.report.container?.runtime_instances ?? [], invocation.containerName ?? containerName, dockerCommand, deps.runDockerCommand, pollOptions);
    const result = await runMoltnetTeamChatConversation(scenario, { apiClient: deps.apiClient, logger, ...pollOptions, pollIntervalMs: pollOptions.intervalMs });
    return { ...result, containerName: invocation.containerName ?? containerName, imageTag: buildResult.imageTag, outputDirectory: buildResult.outputDirectory };
  } catch (error) {
    const histories = await Promise.all([formatHistory(deps.apiClient, scenario.parent), formatHistory(deps.apiClient, scenario.child)]);
    const logs = invocation?.containerName ? await deps.runDockerCommand(dockerCommand, ["logs", invocation.containerName]).catch(() => "") : "";
    const message = error instanceof Error ? error.message : String(error);
    const diagnostics = `${logs ? `\n\nDocker logs:\n${logs}` : ""}\n\nMoltnet histories:\n${histories.join("\n")}`;
    throw new SpawnfileError(isSpawnfileError(error) ? error.code : "runtime_error", `${message}${diagnostics}`);
  } finally {
    await cleanup({ buildResult, dockerCommand, invocation, keepImages: options.keepImages ?? false, runCommand: deps.runDockerCommand });
    if (!options.keepArtifacts) await deps.removeDirectory(root);
  }
};
