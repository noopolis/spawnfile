import { describe, expect, it, vi } from "vitest";

import type { ResolvedAuthProfile } from "../auth/index.js";
import {
  buildProject as realBuildProject,
  createDockerRunInvocation as realCreateDockerRunInvocation,
  syncProjectAuth as realSyncProjectAuth,
  type BuildProjectResult,
  type DockerRunInvocation
} from "../compiler/index.js";

import {
  assertExactRoomMembers,
  createMoltnetTeamChatScenario,
  findRoomMessage,
  runMoltnetTeamChatConversation,
  runMoltnetTeamChatE2E,
  type MoltnetMessage,
  type MoltnetTeamChatApiClient,
  type MoltnetTeamChatScenario
} from "./moltnetTeamChat.js";

const createMessage = (id: string, authorId: string, text: string): MoltnetMessage => ({
  from: { id: authorId, type: authorId === "operator" ? "human" : "agent" },
  id,
  parts: [{ kind: "text", text }]
});

class FakeMoltnetApi implements MoltnetTeamChatApiClient {
  public readonly sent: Array<{ roomId: string; text: string }> = [];
  private readonly messages = new Map<string, MoltnetMessage[]>();

  public constructor(private readonly scenario: MoltnetTeamChatScenario) {
    this.messages.set(scenario.parent.roomId, []);
    this.messages.set(scenario.child.roomId, []);
  }

  public async getRoom(_baseUrl: string, roomId: string) {
    const target = roomId === this.scenario.parent.roomId ? this.scenario.parent : this.scenario.child;
    return { id: roomId, members: target.expectedMembers };
  }

  public async health() {
    return true;
  }

  public async listAgents(_baseUrl: string) {
    return [...this.scenario.parent.expectedMembers, ...this.scenario.child.expectedMembers].map((id) => ({
      id,
      rooms: [
        ...(this.scenario.parent.expectedMembers.includes(id) ? [this.scenario.parent.roomId] : []),
        ...(this.scenario.child.expectedMembers.includes(id) ? [this.scenario.child.roomId] : [])
      ]
    }));
  }

  public async listRoomMessages(_baseUrl: string, roomId: string) {
    return this.messages.get(roomId) ?? [];
  }

  public async sendRoomMessage(input: { roomId: string; text: string }) {
    this.sent.push({ roomId: input.roomId, text: input.text });
    const request = input.text.match(/request=(SF-[A-Za-z0-9-]+)/)?.[1];
    const ack = input.text.match(/ack=(SF-[A-Za-z0-9-]+)/)?.[1];
    if (!request || !ack) return;

    const roomMessages = this.messages.get(input.roomId) ?? [];
    if (input.roomId === this.scenario.parent.roomId) {
      roomMessages.push(createMessage("msg-request", this.scenario.parent.requestAuthorId, request));
      roomMessages.push(createMessage("msg-ack", this.scenario.parent.ackAuthorId, ack));
    } else {
      roomMessages.push(createMessage("msg-child-ack", this.scenario.child.ackAuthorId, ack));
    }
    this.messages.set(input.roomId, roomMessages);
  }
}

const authProfile: ResolvedAuthProfile = {
  authHome: "/tmp/auth",
  env: {},
  imports: {},
  name: "e2e",
  profileDirectory: "/tmp/auth/profiles/e2e",
  profilePath: "/tmp/auth/profiles/e2e/profile.json",
  version: 1
};

const createBuildResult = (outputDirectory: string, imageTag: string): BuildProjectResult => ({
  imageTag,
  outputDirectory,
  report: {
    container: {
      dockerfile: "Dockerfile",
      entrypoint: "entrypoint.sh",
      env_example: ".env.example",
      model_secrets_required: [],
      ports: [8787, 8788],
      runtime_homes: [],
      runtime_instances: [
        {
          config_path: "/var/lib/spawnfile/instances/openclaw/agent-coordinator/home/.openclaw/openclaw.json",
          home_path: "/var/lib/spawnfile/instances/openclaw/agent-coordinator/home",
          id: "agent-coordinator",
          model_auth_methods: {},
          model_secrets_required: [],
          runtime: "openclaw"
        }
      ],
      runtime_secrets_required: [],
      runtimes_installed: ["openclaw"],
      secrets_required: []
    },
    diagnostics: [],
    nodes: [],
    root: "/fixture/Spawnfile",
    spawnfile_version: "0.1"
  },
  reportPath: `${outputDirectory}/spawnfile-report.json`
});

describe("moltnet team chat helpers", () => {
  it("finds messages by sentinel and author", () => {
    const messages = [
      createMessage("wrong", "coordinator", "SF-MOLTNET-E2E-ACK-1"),
      createMessage("right", "field-representative", "SF-MOLTNET-E2E-ACK-1")
    ];

    expect(findRoomMessage(messages, "SF-MOLTNET-E2E-ACK-1", "field-representative")?.id).toBe("right");
    expect(findRoomMessage(messages, "SF-MOLTNET-E2E-ACK-1", "analysis-representative")).toBeUndefined();
  });

  it("requires exact parent room membership", () => {
    const scenario = createMoltnetTeamChatScenario();
    expect(() =>
      assertExactRoomMembers({ id: "mission-control", members: [...scenario.parent.expectedMembers].reverse() }, scenario.parent.expectedMembers)
    ).not.toThrow();
    expect(() =>
      assertExactRoomMembers({ id: "mission-control", members: [...scenario.parent.expectedMembers, "field-observer"] }, scenario.parent.expectedMembers)
    ).toThrow(/extra \[field-observer\]/);
  });

  it("allows alternate host base URLs for occupied local ports", () => {
    const scenario = createMoltnetTeamChatScenario({
      childBaseUrl: "http://127.0.0.1:18788",
      parentBaseUrl: "http://127.0.0.1:18787"
    });

    expect(scenario.parent.baseUrl).toBe("http://127.0.0.1:18787");
    expect(scenario.child.baseUrl).toBe("http://127.0.0.1:18788");
  });
});

describe("runMoltnetTeamChatConversation", () => {
  it("polls rooms, sends seeds, and requires expected authors", async () => {
    const scenario = createMoltnetTeamChatScenario();
    const apiClient = new FakeMoltnetApi(scenario);

    const result = await runMoltnetTeamChatConversation(scenario, {
      apiClient,
      logger: { info: vi.fn() },
      pollIntervalMs: 1,
      sleep: async () => undefined,
      timeoutMs: 1
    });

    expect(apiClient.sent.map((message) => message.roomId)).toEqual(["mission-control", "field-room"]);
    expect(result.parentRequestMessage.from.id).toBe("coordinator");
    expect(result.parentAckMessage.from.id).toBe("field-representative");
    expect(result.childAckMessage.from.id).toBe("field-representative");
  });
});

describe("runMoltnetTeamChatE2E", () => {
  it("can run with fake Docker/API clients without touching Docker", async () => {
    const scenario = createMoltnetTeamChatScenario({ fixtureDirectory: "/fixture" });
    const apiClient = new FakeMoltnetApi(scenario);
    const dockerCalls: string[][] = [];
    const buildProject: typeof realBuildProject = vi.fn(async (_inputPath, options = {}) =>
      createBuildResult(options.outputDirectory ?? "/tmp/out", options.imageTag ?? "image")
    );
    const createDockerRunInvocation: typeof realCreateDockerRunInvocation = vi.fn(async (_build, imageTag, options = {}) => ({
      args: ["run"],
      command: options.dockerCommand ?? "docker",
      containerName: options.containerName ?? "container",
      cwd: "/tmp/out",
      detach: options.detach ?? false,
      envFilePath: "/tmp/run.env",
      imageTag,
      supportDirectory: "/tmp/spawnfile-e2e-fake-support"
    }) satisfies DockerRunInvocation);
    const syncProjectAuth: typeof realSyncProjectAuth = vi.fn(async () => authProfile);

    const result = await runMoltnetTeamChatE2E(
      {
        containerName: "moltnet-test",
        fixtureDirectory: "/fixture",
        imageTag: "moltnet-image",
        logger: { info: vi.fn() },
        pollIntervalMs: 1,
        timeoutMs: 1
      },
      {
        apiClient,
        buildProject,
        createDockerRunInvocation,
        runDockerCommand: async (_command, args) => {
          dockerCalls.push(args);
          return args[0] === "logs" ? "fake logs" : "";
        },
        runDockerContainer: vi.fn(async () => undefined),
        sleep: async () => undefined,
        syncProjectAuth
      }
    );

    expect(result.imageTag).toBe("moltnet-image");
    expect(buildProject).toHaveBeenCalledWith("/fixture", expect.objectContaining({ imageTag: "moltnet-image" }));
    expect(dockerCalls).toContainEqual(expect.arrayContaining(["exec", "moltnet-test", "curl"]));
    expect(dockerCalls).toContainEqual(["rm", "-f", "moltnet-test"]);
    expect(dockerCalls).toContainEqual(["image", "rm", "-f", "moltnet-image"]);
  });
});
