import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readHomeDeploymentRecord, readHomeDeploymentReport } from "../deployment/index.js";
import { removeDirectory } from "../filesystem/index.js";

import { buildDistributionReport } from "./buildDistributionReport.js";
import { DISTRIBUTION_REPORT_IMAGE_PATH } from "./types.js";
import { consumeImageUp } from "./consumeImage.js";

const previousHome = process.env.SPAWNFILE_HOME;
let homeDirectory: string;

const report = () =>
  buildDistributionReport({
    envVariables: [
      { categories: ["model"], generated: false, name: "ANTHROPIC_API_KEY", required: true },
      { categories: ["runtime"], generated: true, name: "OPENCLAW_GATEWAY_TOKEN", required: true }
    ],
    generatedAt: "2026-06-13T00:00:00.000Z",
    internalPorts: [],
    modelAuthMethods: { anthropic: "api_key" },
    moltnetNetworks: [{ binding: "env", id: "dist_lab", server_mode: "managed" }],
    organization: {
      agents: [{ id: "agent:a", name: "a", runtime: "picoclaw", teams: ["team:o"] }],
      project: "distribution-org",
      teams: [{ agents: ["agent:a"], id: "team:o", name: "distribution-org" }]
    },
    persistentMounts: [
      { durability: "persistent", id: "store", kind: "volume", target: "/var/lib/spawnfile/x" }
    ],
    portMappings: [],
    publishedPorts: [],
    resources: [],
    runtimeInstances: [
      {
        config_path: "/c",
        home_path: null,
        id: "picoclaw-a",
        internal_port: null,
        model_auth_methods: { anthropic: "api_key" },
        model_secrets_required: ["ANTHROPIC_API_KEY"],
        node_ids: ["agent:a"],
        published_port: null,
        runtime: "picoclaw",
        workspace_path: "/w"
      }
    ]
  });

const buildTar = (content: Buffer): Buffer => {
  const header = Buffer.alloc(512);
  header.write("spawnfile-report.json", 0, "ascii");
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("0", 156, "ascii");
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(padded);
  return Buffer.concat([header, padded, Buffer.alloc(1024)]);
};

interface FakeDockerState {
  calls: string[][];
}

const createFakeDocker = (state: FakeDockerState, customReport?: ReturnType<typeof report>) => {
  const distributionReport = customReport ?? report();
  const labels = {
    "com.spawnfile.compile_fingerprint": distributionReport.compile_fingerprint,
    "com.spawnfile.image_contract": "spawnfile.image.v1",
    "com.spawnfile.project": "distribution-org",
    "com.spawnfile.report": DISTRIBUTION_REPORT_IMAGE_PATH
  };
  return async (args: string[]): Promise<Buffer> => {
    state.calls.push(args);
    if (args[0] === "image" && args[1] === "inspect" && args.includes("{{json .Config.Labels}}")) {
      return Buffer.from(JSON.stringify(labels));
    }
    if (args[0] === "cp") {
      return buildTar(Buffer.from(JSON.stringify(distributionReport)));
    }
    if (args[0] === "image" && args[1] === "inspect" && args.includes("{{.Id}}")) {
      return Buffer.from("sha256:localimage");
    }
    if (args[0] === "image" && args[1] === "inspect" && args.includes("{{json .RepoDigests}}")) {
      return Buffer.from(JSON.stringify(["you/org@sha256:remotedigest"]));
    }
    if (args[0] === "run") {
      return Buffer.from("container-id-123\n");
    }
    return Buffer.from("");
  };
};

beforeEach(async () => {
  homeDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-consume-test-"));
  process.env.SPAWNFILE_HOME = homeDirectory;
});

afterEach(async () => {
  if (previousHome === undefined) {
    delete process.env.SPAWNFILE_HOME;
  } else {
    process.env.SPAWNFILE_HOME = previousHome;
  }
  await removeDirectory(homeDirectory).catch(() => undefined);
});

describe("consumeImageUp", () => {
  it("deploys, writes a v2 image record and cached report", async () => {
    const state: FakeDockerState = { calls: [] };
    const result = await consumeImageUp("you/org@sha256:" + "a".repeat(64), {
      authValues: { ANTHROPIC_API_KEY: "sk", DIST_REQUIRED_TOKEN: "x" },
      deploymentName: "research",
      runDocker: createFakeDocker(state)
    });

    expect(result.deploymentName).toBe("research");
    const record = await readHomeDeploymentRecord("research");
    expect(record.version).toBe("spawnfile.deployment.v2");
    expect(record.source).toMatchObject({ kind: "image" });
    expect(record.units[0]?.container_id).toBe("container-id-123");
    expect(record.units[0]?.contains).toContainEqual({ id: "dist_lab", kind: "network" });
    const cached = JSON.parse(await readHomeDeploymentReport("research"));
    expect(cached.version).toBe("spawnfile.distribution-report.v1");
  });

  it("uses the pinned digest from a digest-ref directly", async () => {
    const state: FakeDockerState = { calls: [] };
    await consumeImageUp("you/org@sha256:" + "b".repeat(64), {
      authValues: { ANTHROPIC_API_KEY: "sk", DIST_REQUIRED_TOKEN: "x" },
      deploymentName: "pinned",
      runDocker: createFakeDocker(state)
    });
    const record = await readHomeDeploymentRecord("pinned");
    expect(record.source.kind === "image" && record.source.digest).toBe(
      "sha256:" + "b".repeat(64)
    );
  });

  it("derives a deployment-scoped volume mount", async () => {
    const state: FakeDockerState = { calls: [] };
    await consumeImageUp("you/org:1.0.0", {
      authValues: { ANTHROPIC_API_KEY: "sk", DIST_REQUIRED_TOKEN: "x" },
      deploymentName: "vol",
      runDocker: createFakeDocker(state)
    });
    const runCall = state.calls.find((call) => call[0] === "run");
    expect(runCall?.join(" ")).toContain("spawnfile_vol_store:/var/lib/spawnfile/x");
  });

  it("fails preflight before any run when a required secret is missing", async () => {
    const state: FakeDockerState = { calls: [] };
    delete process.env.ANTHROPIC_API_KEY;
    await expect(
      consumeImageUp("you/org:1.0.0", {
        authValues: {},
        deploymentName: "nope",
        runDocker: createFakeDocker(state)
      })
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(state.calls.some((call) => call[0] === "run")).toBe(false);
  });

  it("injects import-based auth mounts when the consumer profile provides the import", async () => {
    const importDir = path.join(homeDirectory, "import", ".claude");
    await mkdir(importDir, { recursive: true });
    await writeFile(
      path.join(importDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "a",
          expiresAt: 1_800_000_000_000,
          refreshToken: "r"
        }
      })
    );
    const claudeReport = buildDistributionReport({
      envVariables: [],
      generatedAt: "2026-06-13T00:00:00.000Z",
      internalPorts: [],
      modelAuthMethods: { anthropic: "claude-code" },
      moltnetNetworks: [],
      organization: {
        agents: [{ id: "agent:assistant", name: "assistant", runtime: "openclaw", teams: [] }],
        project: "distribution-org",
        teams: []
      },
      persistentMounts: [],
      portMappings: [],
      publishedPorts: [],
      resources: [],
      runtimeInstances: [
        {
          config_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/openclaw.json",
          home_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home",
          id: "agent-assistant",
          internal_port: null,
          model_auth_methods: { anthropic: "claude-code" },
          model_secrets_required: [],
          node_ids: ["agent:assistant"],
          published_port: null,
          runtime: "openclaw",
          workspace_path: "/w"
        }
      ]
    });
    const state: FakeDockerState = { calls: [] };
    await consumeImageUp("you/org:1.0.0", {
      authProfile: {
        authHome: "/auth",
        env: {},
        imports: { "claude-code": { kind: "claude-code", path: importDir } },
        name: "me",
        profileDirectory: "/auth/me",
        profilePath: "/auth/me/profile.json",
        version: 1
      },
      deploymentName: "claude-deploy",
      runDocker: createFakeDocker(state, claudeReport)
    });
    const runCall = state.calls.find((call) => call[0] === "run");
    expect(runCall?.join(" ")).toContain(`${importDir}:`);
    expect(runCall?.join(" ")).toContain("auth-profiles.json");
  });

  it("rejects an invalid image reference before touching docker", async () => {
    const state: FakeDockerState = { calls: [] };
    await expect(
      consumeImageUp("Not A Ref", {
        authValues: { ANTHROPIC_API_KEY: "sk" },
        deploymentName: "bad",
        runDocker: createFakeDocker(state)
      })
    ).rejects.toThrow(/Invalid image reference/);
    expect(state.calls).toHaveLength(0);
  });

  it("records a null digest when the registry digest is unavailable", async () => {
    const base = createFakeDocker({ calls: [] });
    const runDocker = async (args: string[]): Promise<Buffer> => {
      if (args[0] === "image" && args[1] === "inspect" && args.includes("{{json .RepoDigests}}")) {
        throw new Error("no repo digests");
      }
      return base(args);
    };
    await consumeImageUp("you/org:1.0.0", {
      authValues: { ANTHROPIC_API_KEY: "sk", DIST_REQUIRED_TOKEN: "x" },
      deploymentName: "nodigest",
      runDocker
    });
    const record = await readHomeDeploymentRecord("nodigest");
    expect(record.source.kind === "image" && record.source.digest).toBeNull();
  });

  it("rejects a derived-name collision without --deployment", async () => {
    const state: FakeDockerState = { calls: [] };
    await consumeImageUp("you/research-cell:1.0.0", {
      authValues: { ANTHROPIC_API_KEY: "sk", DIST_REQUIRED_TOKEN: "x" },
      runDocker: createFakeDocker(state)
    });
    await expect(
      consumeImageUp("you/research-cell:1.0.0", {
        authValues: { ANTHROPIC_API_KEY: "sk", DIST_REQUIRED_TOKEN: "x" },
        runDocker: createFakeDocker({ calls: [] })
      })
    ).rejects.toThrow(/already exists/);
  });
});
