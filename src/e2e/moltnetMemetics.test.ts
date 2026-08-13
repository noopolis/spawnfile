import { describe, expect, it, vi } from "vitest";

import type { ResolvedAuthProfile } from "../auth/index.js";
import {
  buildProject as realBuildProject,
  createDockerRunInvocation as realCreateDockerRunInvocation,
  syncProjectAuth as realSyncProjectAuth,
  type BuildProjectResult,
  type DockerRunInvocation
} from "../compiler/index.js";
import type { OrganizationReadinessEvidence } from "../compiler/organizationReadyEvidence.js";

import {
  createMoltnetMemeticsTarget,
  MOLTNET_MEMETICS_DEFAULT_SEED_TOKEN,
  MOLTNET_MEMETICS_ELEANOR_ID,
  MOLTNET_MEMETICS_ROOM_ID,
  MOLTNET_MEMETICS_SAM_ID,
  runMoltnetMemeticsConversation,
  runMoltnetMemeticsE2E
} from "./moltnetMemetics.js";
import type { MoltnetMessage, MoltnetTeamChatApiClient } from "./moltnetMemeticsTypes.js";

const createMessage = (id: string, authorId: string, text: string): MoltnetMessage => ({
  from: { id: authorId, type: authorId === "operator" ? "human" : "agent" },
  id,
  parts: [{ kind: "text", text }]
});

type SendRoomMessageInput = Parameters<MoltnetTeamChatApiClient["sendRoomMessage"]>[0];

class FakeMemeticsApi implements MoltnetTeamChatApiClient {
  public readonly sent: SendRoomMessageInput[] = [];
  private readonly messages: MoltnetMessage[] = [];
  private nextId = 1;

  public async getRoom(_baseUrl: string, roomId: string) {
    return { id: roomId, members: [MOLTNET_MEMETICS_ELEANOR_ID, MOLTNET_MEMETICS_SAM_ID] };
  }

  public async health() {
    return true;
  }

  public async listAgents(_baseUrl: string) {
    return [
      { connected: true, id: MOLTNET_MEMETICS_ELEANOR_ID, rooms: [MOLTNET_MEMETICS_ROOM_ID] },
      { connected: true, id: MOLTNET_MEMETICS_SAM_ID, rooms: [MOLTNET_MEMETICS_ROOM_ID] }
    ];
  }

  public async listRoomMessages(_baseUrl: string, _roomId: string) {
    return [...this.messages];
  }

  public async sendRoomMessage(input: SendRoomMessageInput) {
    this.sent.push(input);
    this.messages.push(createMessage(`msg-${this.nextId++}`, input.from.id, input.text));

    if (input.from.id === "operator") {
      this.messages.push(createMessage(`msg-${this.nextId++}`, MOLTNET_MEMETICS_ELEANOR_ID, "Confirmed, looping Sam in now. @sam"));
      this.messages.push(createMessage(`msg-${this.nextId++}`, MOLTNET_MEMETICS_SAM_ID, "Pushing back on the date. @eleanor"));
      this.messages.push(createMessage(`msg-${this.nextId++}`, MOLTNET_MEMETICS_ELEANOR_ID, "Agreed, locking the revised date. Closing this out."));
    }
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
const genericOrganizationReadinessEvidence: OrganizationReadinessEvidence = {
  compileFingerprint: "sf1:000000000000", compileVersion: "0.1", hasExternalMoltnet: false,
  networks: [], organizationMembers: [], projectLabel: "generic",
  version: "spawnfile.organization-ready-evidence.v1", worldBindings: null
};

const createBuildResult = (outputDirectory: string, imageTag: string): BuildProjectResult => ({
  imageTag,
  organizationReadinessEvidence: genericOrganizationReadinessEvidence,
  outputDirectory,
  report: {
    container: {
      dockerfile: "Dockerfile",
      entrypoint: "entrypoint.sh",
      env_example: ".env.example",
      model_secrets_required: [],
      ports: [8787],
      runtime_homes: [],
      runtime_instances: [
        {
          config_path: "/var/lib/spawnfile/instances/pi/pi-app/pi/pi-app.json",
          home_path: "/var/lib/spawnfile/instances/pi/pi-app/home",
          id: "pi-app",
          model_auth_methods: { openai: "codex" },
          model_secrets_required: [],
          node_ids: ["agent:eleanor", "agent:sam"],
          runtime: "pi"
        }
      ],
      runtime_secrets_required: [],
      runtimes_installed: ["pi"],
      secrets_required: []
    },
    diagnostics: [],
    nodes: [],
    root: "/fixture/Spawnfile",
    spawnfile_version: "0.1"
  },
  reportPath: `${outputDirectory}/spawnfile-report.json`
});

describe("createMoltnetMemeticsTarget", () => {
  it("targets the single memetics room with both agents", () => {
    const target = createMoltnetMemeticsTarget("http://127.0.0.1:21099");
    expect(target).toEqual({
      baseUrl: "http://127.0.0.1:21099",
      expectedMembers: [MOLTNET_MEMETICS_ELEANOR_ID, MOLTNET_MEMETICS_SAM_ID],
      networkId: "memetics_lab",
      roomId: MOLTNET_MEMETICS_ROOM_ID
    });
  });
});

describe("runMoltnetMemeticsConversation", () => {
  it("seeds the room, waits for Eleanor then Sam, and returns the full transcript", async () => {
    const target = createMoltnetMemeticsTarget("http://127.0.0.1:8787");
    const apiClient = new FakeMemeticsApi();

    const result = await runMoltnetMemeticsConversation(target, {
      apiClient,
      logger: { info: vi.fn() },
      pollIntervalMs: 1,
      sleep: async () => undefined,
      timeoutMs: 1
    });

    expect(apiClient.sent).toHaveLength(1);
    expect(apiClient.sent[0].mentions).toEqual([MOLTNET_MEMETICS_ELEANOR_ID]);
    expect(apiClient.sent[0].text).toContain(MOLTNET_MEMETICS_DEFAULT_SEED_TOKEN);
    expect(result.eleanorReply.from.id).toBe(MOLTNET_MEMETICS_ELEANOR_ID);
    expect(result.samReply.from.id).toBe(MOLTNET_MEMETICS_SAM_ID);
    expect(result.seedToken).toBe(MOLTNET_MEMETICS_DEFAULT_SEED_TOKEN);
    // The exchange captures Eleanor's 3rd-turn close, not just the first Eleanor/Sam pair.
    expect(result.agentTurns.map((message) => message.from.id)).toEqual([
      MOLTNET_MEMETICS_ELEANOR_ID,
      MOLTNET_MEMETICS_SAM_ID,
      MOLTNET_MEMETICS_ELEANOR_ID
    ]);
    expect(["turn-cap", "quiet-timeout", "timeout"]).toContain(result.endedReason);
    expect(result.transcript.map((message) => message.from.id)).toEqual([
      "operator",
      MOLTNET_MEMETICS_ELEANOR_ID,
      MOLTNET_MEMETICS_SAM_ID,
      MOLTNET_MEMETICS_ELEANOR_ID
    ]);
  });

  it("uses a custom seed token when provided", async () => {
    const target = createMoltnetMemeticsTarget("http://127.0.0.1:8787");
    const apiClient = new FakeMemeticsApi();

    const result = await runMoltnetMemeticsConversation(target, {
      apiClient,
      pollIntervalMs: 1,
      seedToken: "CUSTOM-TOKEN-9",
      sleep: async () => undefined,
      timeoutMs: 1
    });

    expect(apiClient.sent[0].text).toContain("CUSTOM-TOKEN-9");
    expect(result.seedToken).toBe("CUSTOM-TOKEN-9");
  });
});

describe("runMoltnetMemeticsE2E", () => {
  it("can run with fake Docker/API clients without touching Docker", async () => {
    const apiClient = new FakeMemeticsApi();
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
    const result = await runMoltnetMemeticsE2E(
      {
        containerName: "moltnet-memetics-test",
        fixtureDirectory: "/fixture",
        imageTag: "moltnet-memetics-image",
        logger: { info: vi.fn() },
        pollIntervalMs: 1,
        runtimePackageOverrides: {},
        timeoutMs: 1
      },
      {
        apiClient,
        buildProject,
        createDockerRunInvocation,
        runDockerCommand: async (_command, args) => {
          dockerCalls.push(args);
          if (args[0] === "logs") return "fake logs";
          if (args[0] === "cp") throw new Error("no telemetry to copy in this fake");
          return "";
        },
        runDockerContainer: vi.fn(async () => undefined),
        sleep: async () => undefined,
        syncProjectAuth
      }
    );

    expect(result.imageTag).toBe("moltnet-memetics-image");
    expect(result.eleanorReply.from.id).toBe(MOLTNET_MEMETICS_ELEANOR_ID);
    expect(result.samReply.from.id).toBe(MOLTNET_MEMETICS_SAM_ID);
    expect(result.agentTurns).toHaveLength(3);
    expect(result.engineLogsCopied).toBe(false);
    expect(buildProject).toHaveBeenCalledWith("/fixture", expect.objectContaining({ imageTag: "moltnet-memetics-image" }));
    expect(dockerCalls).toContainEqual(expect.arrayContaining(["exec", "moltnet-memetics-test", "curl"]));
    expect(dockerCalls).toContainEqual(["rm", "-f", "moltnet-memetics-test"]);
    expect(dockerCalls).toContainEqual(["image", "rm", "-f", "moltnet-memetics-image"]);
  });
});
