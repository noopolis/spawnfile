import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { requireAuthProfile, type ResolvedAuthProfile } from "../auth/index.js";
import {
  buildProject,
  createDockerRunInvocation,
  runDockerContainer,
  syncProjectAuth,
  type BuildProjectResult,
  type DockerRunInvocation
} from "../compiler/index.js";
import { removeDirectory } from "../filesystem/index.js";
import type { ContainerRuntimeInstanceReport } from "../report/index.js";
import { getRuntimeAdapter } from "../runtime/index.js";
import { isSpawnfileError, SpawnfileError } from "../shared/index.js";

const DEFAULT_FIXTURE_DIRECTORY = fileURLToPath(new URL("../../fixtures/e2e/moltnet-team-chat", import.meta.url));
const DEFAULT_PARENT_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_CHILD_BASE_URL = "http://127.0.0.1:8788";

export interface MoltnetTeamChatLogger { info(message: string): void }
export interface MoltnetRoom { id: string; members?: string[] }
export interface MoltnetAgentSummary { id: string; rooms?: string[] }
export interface MoltnetMessage {
  from: { id: string; name?: string; type: string };
  id: string;
  parts: Array<{ kind: string; text?: string }>;
}
export interface MoltnetTeamChatApiClient {
  getRoom(baseUrl: string, roomId: string): Promise<MoltnetRoom>;
  health(baseUrl: string): Promise<boolean>;
  listAgents(baseUrl: string): Promise<MoltnetAgentSummary[]>;
  listRoomMessages(baseUrl: string, roomId: string, limit: number): Promise<MoltnetMessage[]>;
  sendRoomMessage(input: { baseUrl: string; from: { id: string; name?: string; type: string }; mentions?: string[]; roomId: string; text: string }): Promise<void>;
}

interface MoltnetRoomTarget {
  baseUrl: string;
  expectedMembers: string[];
  networkId: string;
  roomId: string;
}
export interface MoltnetTeamChatScenario {
  child: MoltnetRoomTarget & { ackAuthorId: string; seedMentionId: string };
  fixtureDirectory: string;
  parent: MoltnetRoomTarget & { ackAuthorId: string; requestAuthorId: string; seedMentionId: string };
}
export interface MoltnetTeamChatConversationResult {
  childAckMessage: MoltnetMessage;
  parentAckMessage: MoltnetMessage;
  parentRequestMessage: MoltnetMessage;
  sentinels: { childAck: string; childRequest: string; parentAck: string; parentRequest: string };
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
  logger?: MoltnetTeamChatLogger;
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

type DockerCommandRunner = (dockerCommand: string, args: string[]) => Promise<string>;
export interface MoltnetTeamChatDependencies {
  apiClient?: MoltnetTeamChatApiClient;
  buildProject?: typeof buildProject;
  createDockerRunInvocation?: typeof createDockerRunInvocation;
  removeDirectory?: typeof removeDirectory;
  requireAuthProfile?: typeof requireAuthProfile;
  runDockerCommand?: DockerCommandRunner;
  runDockerContainer?: typeof runDockerContainer;
  sleep?: (delayMs: number) => Promise<void>;
  syncProjectAuth?: typeof syncProjectAuth;
}

const sleep = async (delayMs: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, delayMs); });
const loggerFor = (logger?: MoltnetTeamChatLogger): MoltnetTeamChatLogger =>
  logger ?? { info: (message) => console.log(message) };

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

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new SpawnfileError("runtime_error", `Moltnet ${init?.method ?? "GET"} ${url} returned ${response.status}${body ? `: ${body}` : ""}`);
  }
  return (await response.json()) as T;
};

export const createMoltnetHttpClient = (): MoltnetTeamChatApiClient => ({
  getRoom: (baseUrl, roomId) => fetchJson(`${baseUrl}/v1/rooms/${encodeURIComponent(roomId)}`),
  async health(baseUrl) {
    try {
      return (await fetch(`${baseUrl}/healthz`)).ok;
    } catch {
      return false;
    }
  },
  async listAgents(baseUrl) {
    return (await fetchJson<{ agents: MoltnetAgentSummary[] }>(`${baseUrl}/v1/agents`)).agents ?? [];
  },
  async listRoomMessages(baseUrl, roomId, limit) {
    const url = `${baseUrl}/v1/rooms/${encodeURIComponent(roomId)}/messages?limit=${limit}`;
    return (await fetchJson<{ messages: MoltnetMessage[] }>(url)).messages ?? [];
  },
  async sendRoomMessage(input) {
    await fetchJson(`${input.baseUrl}/v1/messages`, {
      body: JSON.stringify({
        from: input.from,
        mentions: input.mentions ?? [],
        parts: [{ kind: "text", text: input.text }],
        target: { kind: "room", room_id: input.roomId }
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST"
    });
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

export const assertExactRoomMembers = (room: MoltnetRoom, expectedMembers: string[]): void => {
  const expected = [...expectedMembers].sort();
  const actual = [...(room.members ?? [])].sort();
  const missing = expected.filter((member) => !actual.includes(member));
  const extra = actual.filter((member) => !expected.includes(member));
  if (missing.length > 0 || extra.length > 0) {
    throw new SpawnfileError("runtime_error", `Room ${room.id} membership mismatch; missing [${missing.join(", ")}], extra [${extra.join(", ")}]`);
  }
};

interface PollOptions { intervalMs: number; sleep: (delayMs: number) => Promise<void>; timeoutMs: number }
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

const waitForRoom = (client: MoltnetTeamChatApiClient, target: MoltnetRoomTarget, options: PollOptions) =>
  poll(`Moltnet room ${target.networkId}/${target.roomId}`, options, async () => {
    const room = await client.getRoom(target.baseUrl, target.roomId);
    assertExactRoomMembers(room, target.expectedMembers);
    return room;
  });
const waitForAgents = (client: MoltnetTeamChatApiClient, target: MoltnetRoomTarget, options: PollOptions) =>
  poll(`Moltnet bridge attachments for ${target.networkId}`, options, async () => {
    const agents = await client.listAgents(target.baseUrl);
    const ready = target.expectedMembers.every((id) =>
      agents.some((agent) => agent.id === id && (agent.rooms ?? []).includes(target.roomId))
    );
    return ready ? agents : null;
  });
const waitForMessage = (client: MoltnetTeamChatApiClient, target: MoltnetRoomTarget, sentinel: string, authorId: string, options: PollOptions) =>
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
  return { childAckMessage, parentAckMessage, parentRequestMessage, sentinels };
};

const runDockerCommand: DockerCommandRunner = async (dockerCommand, args) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(dockerCommand, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on("data", (chunk: Buffer | string) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk: Buffer | string) => stderr.push(String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout.join("").trim()) : reject(new Error(stderr.join("").trim() || `${dockerCommand} ${args.join(" ")} failed`)));
  });

const healthPathForRuntime = (runtimeName: string): string =>
  runtimeName === "openclaw" ? "/healthz" : runtimeName === "picoclaw" ? "/health" : "/api/agents";
const waitForRuntimeReadiness = async (instances: ContainerRuntimeInstanceReport[], containerName: string, dockerCommand: string, runCommand: DockerCommandRunner, options: PollOptions): Promise<void> => {
  const counts = new Map<string, number>();
  for (const instance of instances) counts.set(instance.runtime, (counts.get(instance.runtime) ?? 0) + 1);
  for (const [runtimeName, count] of counts) {
    const meta = getRuntimeAdapter(runtimeName).container;
    if (!meta.port) continue;
    for (let index = 0; index < count; index += 1) {
      const port = meta.port + (index * (meta.portStride ?? 1));
      await poll(`${runtimeName} runtime on ${port}`, options, async () => {
        try {
          await runCommand(dockerCommand, ["exec", containerName, "curl", "-sf", `http://127.0.0.1:${port}${healthPathForRuntime(runtimeName)}`]);
          return true;
        } catch {
          return null;
        }
      });
    }
  }
};

const withSpawnfileHome = async <T>(spawnfileHome: string, fn: () => Promise<T>): Promise<T> => {
  const previous = process.env.SPAWNFILE_HOME;
  process.env.SPAWNFILE_HOME = spawnfileHome;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.SPAWNFILE_HOME;
    else process.env.SPAWNFILE_HOME = previous;
  }
};

const resolveAuthProfile = async (
  fixtureDirectory: string,
  spawnfileHome: string,
  options: RunMoltnetTeamChatE2EOptions,
  deps: Required<Pick<MoltnetTeamChatDependencies, "requireAuthProfile" | "syncProjectAuth">>
): Promise<ResolvedAuthProfile | null> => {
  const profileName = options.authProfileName ?? "e2e";
  if (options.syncAuth ?? true) {
    return withSpawnfileHome(spawnfileHome, () => deps.syncProjectAuth(fixtureDirectory, {
      claudeCodeDirectory: options.claudeCodeDirectory,
      codexDirectory: options.codexDirectory,
      envFilePath: options.envFilePath,
      profileName
    }));
  }
  return options.authProfileName ? deps.requireAuthProfile(options.authProfileName) : null;
};

const cleanup = async (input: { buildResult?: BuildProjectResult; dockerCommand: string; invocation?: DockerRunInvocation; keepImages: boolean; runCommand: DockerCommandRunner }): Promise<void> => {
  const containerName = input.invocation?.containerName;
  if (containerName) await input.runCommand(input.dockerCommand, ["rm", "-f", containerName]).catch(() => undefined);
  if (input.buildResult && !input.keepImages) await input.runCommand(input.dockerCommand, ["image", "rm", "-f", input.buildResult.imageTag]).catch(() => undefined);
  for (const mount of input.buildResult?.report.container?.persistent_mounts ?? []) {
    await input.runCommand(input.dockerCommand, ["volume", "rm", "-f", mount.volume_name]).catch(() => undefined);
  }
  if (input.invocation) await removeDirectory(input.invocation.supportDirectory);
};

const formatHistory = async (client: MoltnetTeamChatApiClient, target: MoltnetRoomTarget): Promise<string> => {
  try {
    const messages = await client.listRoomMessages(target.baseUrl, target.roomId, 20);
    return [`${target.networkId}/${target.roomId}:`, ...messages.map((message) => `- ${message.from.id}: ${textOf(message)}`)].join("\n");
  } catch (error) {
    return `${target.networkId}/${target.roomId}: ${error instanceof Error ? error.message : String(error)}`;
  }
};

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
