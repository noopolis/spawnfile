import { spawn } from "node:child_process";

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
import { SpawnfileError } from "../shared/index.js";
import type { MoltnetAgentSummary, MoltnetApiClient, MoltnetMessage, MoltnetRoom } from "./moltnetWireTypes.js";

/**
 * Generic Docker/Moltnet boot+observe plumbing reused by every bespoke E2E driver (moltnetTeamChat.ts,
 * moltnetMemetics.ts, officeSim.ts, ...). Nothing in this module knows about any one scenario's rooms, agents, or
 * sentinel protocol — that lives in each driver's own module.
 */

export interface MoltnetRoomTarget {
  baseUrl: string;
  expectedMembers: string[];
  networkId: string;
  roomId: string;
}

export type DockerCommandRunner = (dockerCommand: string, args: string[]) => Promise<string>;

export interface MoltnetE2EDependencies {
  apiClient?: MoltnetApiClient;
  buildProject?: typeof buildProject;
  createDockerRunInvocation?: typeof createDockerRunInvocation;
  removeDirectory?: typeof removeDirectory;
  requireAuthProfile?: typeof requireAuthProfile;
  runDockerCommand?: DockerCommandRunner;
  runDockerContainer?: typeof runDockerContainer;
  sleep?: (delayMs: number) => Promise<void>;
  syncProjectAuth?: typeof syncProjectAuth;
}

/** The subset of a driver's own `RunXE2EOptions` that resolveAuthProfile needs. Every driver's options type
 * (RunMoltnetTeamChatE2EOptions, RunMoltnetMemeticsE2EOptions, RunOfficeSimE2EOptions, ...) is structurally
 * assignable here — this is intentionally the narrow shared shape, not a union of all of them. */
export interface MoltnetAuthResolutionOptions {
  authProfileName?: string;
  claudeCodeDirectory?: string;
  codexDirectory?: string;
  envFilePath?: string;
  syncAuth?: boolean;
}

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new SpawnfileError("runtime_error", `Moltnet ${init?.method ?? "GET"} ${url} returned ${response.status}${body ? `: ${body}` : ""}`);
  }
  return (await response.json()) as T;
};

export const createMoltnetHttpClient = (): MoltnetApiClient => ({
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

export const assertExactRoomMembers = (room: MoltnetRoom, expectedMembers: string[]): void => {
  const expected = [...expectedMembers].sort();
  const actual = [...(room.members ?? [])].sort();
  const missing = expected.filter((member) => !actual.includes(member));
  const extra = actual.filter((member) => !expected.includes(member));
  if (missing.length > 0 || extra.length > 0) {
    throw new SpawnfileError("runtime_error", `Room ${room.id} membership mismatch; missing [${missing.join(", ")}], extra [${extra.join(", ")}]`);
  }
};

export interface PollOptions {
  intervalMs: number;
  sleep: (delayMs: number) => Promise<void>;
  timeoutMs: number;
}
export const poll = async <T>(description: string, options: PollOptions, attempt: () => Promise<T | null>): Promise<T> => {
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

export const waitForRoom = (client: MoltnetApiClient, target: MoltnetRoomTarget, options: PollOptions) =>
  poll(`Moltnet room ${target.networkId}/${target.roomId}`, options, async () => {
    const room = await client.getRoom(target.baseUrl, target.roomId);
    assertExactRoomMembers(room, target.expectedMembers);
    return room;
  });
export const waitForAgents = (client: MoltnetApiClient, target: MoltnetRoomTarget, options: PollOptions) =>
  poll(`Moltnet bridge attachments for ${target.networkId}`, options, async () => {
    const agents = await client.listAgents(target.baseUrl);
    // Gate on the agent's DYNAMIC connected flag, not merely room membership:
    // /v1/agents can list an agent purely from static room-config membership
    // before its bridge has ever attached, and seeding then is unrecoverable.
    // After the moltnet fix (SubscribeFrom precedes AgentConnected), connected
    // truthfully implies the bridge's broker subscription is live, so a message
    // sent once all members are connected cannot fall in the delivery gap.
    const ready = target.expectedMembers.every((id) =>
      agents.some((agent) => agent.id === id && (agent.rooms ?? []).includes(target.roomId) && agent.connected === true)
    );
    return ready ? agents : null;
  });

export const runDockerCommand: DockerCommandRunner = async (dockerCommand, args) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(dockerCommand, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on("data", (chunk: Buffer | string) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk: Buffer | string) => stderr.push(String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout.join("").trim()) : reject(new Error(stderr.join("").trim() || `${dockerCommand} ${args.join(" ")} failed`)));
  });

export const healthPathForRuntime = (runtimeName: string): string =>
  runtimeName === "openclaw" ? "/healthz"
    : runtimeName === "picoclaw" ? "/health"
    : runtimeName === "pi" || runtimeName === "daimon" ? "/healthz"
    : "/api/agents";
export const waitForRuntimeReadiness = async (instances: ContainerRuntimeInstanceReport[], containerName: string, dockerCommand: string, runCommand: DockerCommandRunner, options: PollOptions): Promise<void> => {
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

export const resolveAuthProfile = async (
  fixtureDirectory: string,
  spawnfileHome: string,
  options: MoltnetAuthResolutionOptions,
  deps: Required<Pick<MoltnetE2EDependencies, "requireAuthProfile" | "syncProjectAuth">>
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

export const cleanup = async (input: { buildResult?: BuildProjectResult; dockerCommand: string; invocation?: DockerRunInvocation; keepImages: boolean; runCommand: DockerCommandRunner }): Promise<void> => {
  const containerName = input.invocation?.containerName;
  if (containerName) await input.runCommand(input.dockerCommand, ["rm", "-f", containerName]).catch(() => undefined);
  if (input.buildResult && !input.keepImages) await input.runCommand(input.dockerCommand, ["image", "rm", "-f", input.buildResult.imageTag]).catch(() => undefined);
  for (const mount of input.buildResult?.report.container?.persistent_mounts ?? []) {
    await input.runCommand(input.dockerCommand, ["volume", "rm", "-f", mount.volume_name]).catch(() => undefined);
  }
  if (input.invocation) await removeDirectory(input.invocation.supportDirectory);
};

export const formatHistory = async (client: MoltnetApiClient, target: MoltnetRoomTarget): Promise<string> => {
  try {
    const messages = await client.listRoomMessages(target.baseUrl, target.roomId, 20);
    return [`${target.networkId}/${target.roomId}:`, ...messages.map((message) => `- ${message.from.id}: ${textOf(message)}`)].join("\n");
  } catch (error) {
    return `${target.networkId}/${target.roomId}: ${error instanceof Error ? error.message : String(error)}`;
  }
};
