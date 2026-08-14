import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  buildProject,
  createDockerRunInvocation,
  runDockerContainer,
  syncProjectAuth,
  type BuildProjectResult,
  type DockerRunInvocation
} from "../compiler/index.js";
import { ensureDirectory, fileExists, readUtf8File, removeDirectory, writeUtf8File } from "../filesystem/index.js";
import { requireAuthProfile } from "../auth/index.js";
import { isSpawnfileError, SpawnfileError } from "../shared/index.js";
import {
  cleanup,
  createMoltnetHttpClient,
  formatHistory,
  poll,
  resolveAuthProfile,
  runDockerCommand,
  waitForAgents,
  waitForRoom,
  waitForRuntimeReadiness,
  type MoltnetRoomTarget,
  type MoltnetTeamChatDependencies
} from "./moltnetTeamChat.js";
import { assertRuntimePackageOverrideDistsBuilt } from "./runtimePackageOverrides.js";
import {
  agentSlugFromNodeId,
  copyContainerPathToHost,
  countJsonlLines,
  renderMemeticsTranscriptMarkdown,
  resolveInstanceRoot,
  serializeMemeticsTranscriptJsonl
} from "./moltnetMemeticsArtifacts.js";
import { DEFAULT_QUIET_GRACE_MS, resolveTargetTurns, waitForConversationExchange } from "./moltnetMemeticsExchange.js";
import type {
  MoltnetMemeticsConversationResult,
  MoltnetMessage,
  MoltnetTeamChatApiClient,
  MoltnetTeamChatLogger,
  RunMoltnetMemeticsE2EOptions,
  RunMoltnetMemeticsE2EResult
} from "./moltnetMemeticsTypes.js";

export type { MoltnetTeamChatLogger } from "./moltnetTeamChatTypes.js";
export type {
  MoltnetMemeticsConversationResult,
  MoltnetMessage,
  RunMoltnetMemeticsE2EOptions,
  RunMoltnetMemeticsE2EResult
} from "./moltnetMemeticsTypes.js";

const DEFAULT_FIXTURE_DIRECTORY = fileURLToPath(new URL("../../fixtures/moltnet-memetics", import.meta.url));
const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
export const MOLTNET_MEMETICS_NETWORK_ID = "memetics_lab";
export const MOLTNET_MEMETICS_ROOM_ID = "eleanor-home";
export const MOLTNET_MEMETICS_ELEANOR_ID = "eleanor";
export const MOLTNET_MEMETICS_SAM_ID = "sam";
export const MOLTNET_MEMETICS_DEFAULT_SEED_TOKEN = "ORCHID-417";

export type MoltnetMemeticsDependencies = MoltnetTeamChatDependencies;

const sleep = async (delayMs: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, delayMs); });
const loggerFor = (logger?: MoltnetTeamChatLogger): MoltnetTeamChatLogger => logger ?? { info: (message) => console.log(message) };

export const createMoltnetMemeticsTarget = (baseUrl: string): MoltnetRoomTarget => ({
  baseUrl,
  expectedMembers: [MOLTNET_MEMETICS_ELEANOR_ID, MOLTNET_MEMETICS_SAM_ID],
  networkId: MOLTNET_MEMETICS_NETWORK_ID,
  roomId: MOLTNET_MEMETICS_ROOM_ID
});

export const runMoltnetMemeticsConversation = async (
  target: MoltnetRoomTarget,
  options: {
    apiClient: MoltnetTeamChatApiClient;
    logger?: MoltnetTeamChatLogger;
    pollIntervalMs: number;
    /** Grace period after the last observed agent message before concluding the exchange is over. Defaults to
     * DEFAULT_QUIET_GRACE_MS (see moltnetMemeticsExchange.ts). */
    quietGraceMs?: number;
    seedToken?: string;
    sleep: (delayMs: number) => Promise<void>;
    /** Target agent-turn count before concluding the exchange is over. Clamped up to MIN_TARGET_TURNS. */
    targetTurns?: number;
    timeoutMs: number;
  }
): Promise<MoltnetMemeticsConversationResult> => {
  const logger = loggerFor(options.logger);
  const pollOptions = { intervalMs: options.pollIntervalMs, sleep: options.sleep, timeoutMs: options.timeoutMs };
  const seedToken = options.seedToken ?? MOLTNET_MEMETICS_DEFAULT_SEED_TOKEN;
  const targetTurns = resolveTargetTurns(options.targetTurns);
  const quietGraceMs = options.quietGraceMs ?? DEFAULT_QUIET_GRACE_MS;

  logger.info(`moltnet ${target.networkId}: waiting for health`);
  await poll(`Moltnet ${target.networkId} health`, pollOptions, async () => (await options.apiClient.health(target.baseUrl)) ? true : null);
  await waitForRoom(options.apiClient, target, pollOptions);
  await waitForAgents(options.apiClient, target, pollOptions);

  const baseline = await options.apiClient.listRoomMessages(target.baseUrl, target.roomId, 100);
  const baselineIds = new Set(baseline.map((message) => message.id));

  const seedMessageText = `@eleanor We need to finalize the ${seedToken} rollout with Sam: propose the two specifics — the pilot site and the go-live date — and get Sam's agreement.`;
  logger.info(`moltnet ${target.networkId}: sending operator seed`);
  await options.apiClient.sendRoomMessage({
    baseUrl: target.baseUrl,
    from: { id: "operator", name: "Moltnet Memetics E2E", type: "human" },
    mentions: [MOLTNET_MEMETICS_ELEANOR_ID],
    roomId: target.roomId,
    text: seedMessageText
  });

  logger.info(`moltnet ${target.networkId}: waiting for the full exchange (target ${targetTurns} turns, quiet grace ${quietGraceMs}ms)`);
  const exchange = await waitForConversationExchange(
    options.apiClient,
    target,
    baselineIds,
    {
      agentIds: [MOLTNET_MEMETICS_ELEANOR_ID, MOLTNET_MEMETICS_SAM_ID],
      intervalMs: options.pollIntervalMs,
      quietGraceMs,
      sleep: options.sleep,
      targetTurns,
      timeoutMs: options.timeoutMs
    },
    logger
  );
  logger.info(`moltnet ${target.networkId}: exchange concluded (${exchange.agentTurns.length} turns, reason=${exchange.endedReason})`);

  const eleanorReply = exchange.agentTurns.find((message) => message.from.id === MOLTNET_MEMETICS_ELEANOR_ID);
  if (!eleanorReply) {
    throw new SpawnfileError("runtime_error", `Moltnet memetics exchange in ${target.roomId} never got a reply from Eleanor`);
  }
  const samReply = exchange.agentTurns.find((message) => message.from.id === MOLTNET_MEMETICS_SAM_ID);
  if (!samReply) {
    throw new SpawnfileError("runtime_error", `Moltnet memetics exchange in ${target.roomId} never got a reply from Sam`);
  }

  return {
    agentTurns: exchange.agentTurns,
    eleanorReply,
    endedReason: exchange.endedReason,
    samReply,
    seedMessageText,
    seedToken,
    transcript: exchange.transcript
  };
};

interface CaptureRunArtifactsInput {
  containerName: string;
  dockerCommand: string;
  instanceRoot: string | null;
  roomId: string;
  runCommand: MoltnetTeamChatDependencies["runDockerCommand"];
  runFolder: string;
  seedToken: string;
  transcript: MoltnetMessage[];
}
const captureRunArtifacts = async (
  input: CaptureRunArtifactsInput
): Promise<{ causalEventCounts: Record<string, number>; engineLogsCopied: boolean }> => {
  await ensureDirectory(input.runFolder);
  await writeUtf8File(path.join(input.runFolder, "transcript.jsonl"), serializeMemeticsTranscriptJsonl(input.transcript));
  await writeUtf8File(
    path.join(input.runFolder, "transcript.md"),
    renderMemeticsTranscriptMarkdown(input.transcript, { roomId: input.roomId, seedToken: input.seedToken })
  );

  const causalEventCounts: Record<string, number> = {};
  if (!input.instanceRoot || !input.runCommand) {
    return { causalEventCounts, engineLogsCopied: false };
  }

  const engineLogsDir = path.join(input.runFolder, "engine-logs");
  const engineLogsCopied = await copyContainerPathToHost({
    containerName: input.containerName,
    containerPath: `${input.instanceRoot}/runtime/agents`,
    dockerCommand: input.dockerCommand,
    hostPath: engineLogsDir,
    runCommand: input.runCommand
  });

  if (engineLogsCopied) {
    for (const agentId of [MOLTNET_MEMETICS_ELEANOR_ID, MOLTNET_MEMETICS_SAM_ID]) {
      const causalPath = path.join(engineLogsDir, agentId, "telemetry", "causal.jsonl");
      if (await fileExists(causalPath)) {
        causalEventCounts[agentId] = countJsonlLines(await readUtf8File(causalPath));
      }
    }
  }

  return { causalEventCounts, engineLogsCopied };
};

const resolvePiInstanceRoot = (buildResult: BuildProjectResult | undefined): string | null => {
  const instance = (buildResult?.report.container?.runtime_instances ?? []).find(
    (candidate) => (candidate.runtime === "pi" || candidate.runtime === "daimon") && candidate.home_path
  );
  return instance?.home_path ? resolveInstanceRoot(instance.home_path) : null;
};

export const runMoltnetMemeticsE2E = async (
  options: RunMoltnetMemeticsE2EOptions = {},
  dependencies: MoltnetMemeticsDependencies = {}
): Promise<RunMoltnetMemeticsE2EResult> => {
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
  const fixtureDirectory = options.fixtureDirectory ?? DEFAULT_FIXTURE_DIRECTORY;
  const target = createMoltnetMemeticsTarget(options.baseUrl ?? DEFAULT_BASE_URL);
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-e2e-moltnet-memetics-"));
  const runFolder = options.runFolder ?? await mkdtemp(path.join(os.tmpdir(), "spawnfile-moltnet-memetics-run-"));
  const dockerCommand = options.dockerCommand ?? "docker";
  const outputDirectory = options.outputDirectory ?? path.join(root, "dist");
  const containerName = options.containerName ?? "spawnfile-e2e-moltnet-memetics";
  const seedToken = options.seedToken ?? MOLTNET_MEMETICS_DEFAULT_SEED_TOKEN;
  let buildResult: BuildProjectResult | undefined;
  let invocation: DockerRunInvocation | undefined;

  const runtimePackageOverrides = options.runtimePackageOverrides;

  try {
    if (runtimePackageOverrides) {
      await assertRuntimePackageOverrideDistsBuilt(runtimePackageOverrides);
    }
    logger.info("moltnet-memetics: syncing auth");
    const authProfile = await resolveAuthProfile(fixtureDirectory, path.join(root, "spawnfile-home"), options, deps);
    logger.info("moltnet-memetics: building image");
    buildResult = await deps.buildProject(fixtureDirectory, {
      dockerCommand,
      imageTag: options.imageTag ?? `spawnfile-e2e-moltnet-memetics-${Date.now()}`,
      outputDirectory,
      runtimePackageOverrides
    });
    invocation = await deps.createDockerRunInvocation(buildResult, buildResult.imageTag, {
      authProfile,
      containerName,
      detach: true,
      dockerCommand
    });
    logger.info(`moltnet-memetics: starting container ${invocation.containerName ?? containerName}`);
    await deps.runDockerContainer(invocation);
    const pollOptions = { intervalMs: options.pollIntervalMs ?? 2_000, sleep: deps.sleep, timeoutMs: options.timeoutMs ?? 240_000 };
    await waitForRuntimeReadiness(
      buildResult.report.container?.runtime_instances ?? [],
      invocation.containerName ?? containerName,
      dockerCommand,
      deps.runDockerCommand,
      pollOptions
    );

    const conversation = await runMoltnetMemeticsConversation(target, {
      apiClient: deps.apiClient,
      logger,
      pollIntervalMs: pollOptions.intervalMs,
      quietGraceMs: options.quietGraceMs,
      seedToken,
      sleep: deps.sleep,
      targetTurns: options.targetTurns,
      timeoutMs: pollOptions.timeoutMs
    });

    const artifacts = await captureRunArtifacts({
      containerName: invocation.containerName ?? containerName,
      dockerCommand,
      instanceRoot: resolvePiInstanceRoot(buildResult),
      roomId: target.roomId,
      runCommand: deps.runDockerCommand,
      runFolder,
      seedToken,
      transcript: conversation.transcript
    });
    logger.info(`moltnet-memetics: run folder ${runFolder}`);

    return {
      ...conversation,
      ...artifacts,
      containerName: invocation.containerName ?? containerName,
      imageTag: buildResult.imageTag,
      outputDirectory: buildResult.outputDirectory,
      runFolder
    };
  } catch (error) {
    const history = await formatHistory(deps.apiClient, target);
    const logs = invocation?.containerName ? await deps.runDockerCommand(dockerCommand, ["logs", invocation.containerName]).catch(() => "") : "";
    const partialTranscript = await deps.apiClient.listRoomMessages(target.baseUrl, target.roomId, 200).catch(() => [] as MoltnetMessage[]);
    await captureRunArtifacts({
      containerName: invocation?.containerName ?? containerName,
      dockerCommand,
      instanceRoot: resolvePiInstanceRoot(buildResult),
      roomId: target.roomId,
      runCommand: deps.runDockerCommand,
      runFolder,
      seedToken,
      transcript: partialTranscript
    }).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    const diagnostics = `${logs ? `\n\nDocker logs:\n${logs}` : ""}\n\nMoltnet history:\n${history}\n\nRun folder: ${runFolder}`;
    throw new SpawnfileError(isSpawnfileError(error) ? error.code : "runtime_error", `${message}${diagnostics}`);
  } finally {
    await cleanup({ buildResult, dockerCommand, invocation, keepImages: options.keepImages ?? false, runCommand: deps.runDockerCommand });
    if (!options.keepArtifacts) await deps.removeDirectory(root);
  }
};

export { agentSlugFromNodeId };
