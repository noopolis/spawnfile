import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { downDeployment, readHomeDeploymentRecord, readHomeDeploymentReport } from "../deployment/index.js";
import { removeDirectory } from "../filesystem/index.js";

import { buildDistributionReport } from "./buildDistributionReport.js";
import { DISTRIBUTION_REPORT_IMAGE_PATH } from "./types.js";
import type { DistributionPersistentMount } from "./types.js";
import { consumeImageUp } from "./consumeImage.js";

const previousHome = process.env.SPAWNFILE_HOME;
const previousDaimonCodexSource = process.env.SPAWNFILE_DAIMON_SOURCE_CODEX_AUTH;
const previousDaimonGrokSource = process.env.SPAWNFILE_DAIMON_SOURCE_GROK_AUTH;
let homeDirectory: string;

const report = (persistentMounts: DistributionPersistentMount[] = [
  { durability: "persistent" as const, id: "store", kind: "volume" as const, target: "/var/lib/spawnfile/x" }
]) =>
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
    persistentMounts,
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

const daimonReport = () => buildDistributionReport({
  envVariables: [], generatedAt: "2026-08-26T00:00:00.000Z", internalPorts: [],
  modelAuthMethods: {}, moltnetNetworks: [],
  organization: { agents: [
    { id: "agent:coder", name: "coder", runtime: "daimon", teams: [] },
    { id: "agent:reviewer", name: "reviewer", runtime: "daimon", teams: [] }
  ], project: "distribution-org", teams: [] },
  persistentMounts: [{ durability: "persistent", id: "grok-realm", kind: "volume", lifecycle: "exclusive-reattach", target: "/var/lib/spawnfile/daimon/grok-subscription-realm" }],
  portMappings: [], publishedPorts: [], resources: [],
  runtimeInstances: [{
    config_path: "/var/lib/spawnfile/instances/daimon/daimon-organization/daimon/daimon-organization-runtime.json",
    engine_by_node_id: { "agent:coder": "codex", "agent:reviewer": "grok" },
    home_path: null, id: "daimon-organization", internal_port: null,
    model_auth_methods: {}, model_secrets_required: [], node_ids: ["agent:coder", "agent:reviewer"],
    published_port: null, runtime: "daimon", workspace_path: "/var/lib/spawnfile/instances/daimon/daimon-organization/workspace"
  }]
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

const candidateContainerId = "c".repeat(64);
const previousContainerId = "d".repeat(64);

const createFakeDocker = (
  state: FakeDockerState,
  customReport?: ReturnType<typeof report>,
  options: { liveExists?: boolean; runOutput?: string } = {}
) => {
  const distributionReport = customReport ?? report();
  const containers = new Map<string, {
    id: string; labels: Record<string, string>; name: string; running: boolean;
  }>();
  let previousSeeded = false;
  let reservationSequence = 0;
  const labels = {
    "com.spawnfile.compile_fingerprint": distributionReport.compile_fingerprint,
    "com.spawnfile.image_contract": "spawnfile.image.v1",
    "com.spawnfile.project": "distribution-org",
    "com.spawnfile.report": DISTRIBUTION_REPORT_IMAGE_PATH
  };
  const find = (reference: string) => [...containers.values()].find(
    (container) => container.id === reference || container.name === reference
  );
  const seedPrevious = (reference: string) => {
    if (!options.liveExists || previousSeeded || !reference.startsWith("spawnfile-")) return;
    previousSeeded = true;
    containers.set(previousContainerId, {
      id: previousContainerId, labels: {}, name: reference, running: true
    });
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
    if (args[0] === "rename") {
      const container = find(args[1]!);
      if (!container) throw new Error("No such container");
      container.name = args[2]!;
      return Buffer.from("");
    }
    if (args[0] === "rm" || (args[0] === "container" && args[1] === "rm")) {
      const container = find(args[args.length - 1]!);
      if (!container) throw new Error("No such container");
      containers.delete(container.id);
      return Buffer.from("");
    }
    if (args[0] === "stop" || args[0] === "start") {
      const container = find(args[1]!);
      if (!container) throw new Error("No such container");
      container.running = args[0] === "start";
      return Buffer.from("");
    }
    if (args[0] === "container" && args[1] === "create") {
      const name = args[args.indexOf("--name") + 1]!;
      if ([...containers.values()].some((container) => container.name === name)) {
        throw new Error("Conflict. container name already in use");
      }
      const reservationLabels: Record<string, string> = {};
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] !== "--label") continue;
        const [key, value] = args[index + 1]!.split("=", 2);
        reservationLabels[key!] = value!;
      }
      const id = `${(++reservationSequence).toString(16)}`.padStart(64, "e");
      containers.set(id, { id, labels: reservationLabels, name, running: false });
      return Buffer.from(`${id}\n`);
    }
    if (args[0] === "container" && args[1] === "inspect") {
      const reference = args[args.length - 1]!;
      seedPrevious(reference);
      const container = find(reference);
      if (!container) throw new Error("No such container");
      const format = args[args.indexOf("--format") + 1] ?? "";
      if (format.includes(".Config.Labels")) {
        return Buffer.from(`${JSON.stringify(container.id)}\n${JSON.stringify(container.labels)}`);
      }
      if (format.includes("{{json .State}}")) {
        return Buffer.from([
          JSON.stringify(container.id), JSON.stringify(`/${container.name}`),
          JSON.stringify({ Running: container.running, Status: container.running ? "running" : "exited" })
        ].join("\n"));
      }
      return Buffer.from([
        JSON.stringify(container.id), JSON.stringify(`/${container.name}`), JSON.stringify(container.running)
      ].join("\n"));
    }
    if (args[0] === "run") {
      const nameIndex = args.indexOf("--name");
      if (nameIndex >= 0) {
        containers.set(candidateContainerId, {
          id: candidateContainerId, labels: {}, name: args[nameIndex + 1]!, running: true
        });
      }
      return Buffer.from(options.runOutput ?? `${candidateContainerId}\n`);
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
  if (previousDaimonCodexSource === undefined) delete process.env.SPAWNFILE_DAIMON_SOURCE_CODEX_AUTH;
  else process.env.SPAWNFILE_DAIMON_SOURCE_CODEX_AUTH = previousDaimonCodexSource;
  if (previousDaimonGrokSource === undefined) delete process.env.SPAWNFILE_DAIMON_SOURCE_GROK_AUTH;
  else process.env.SPAWNFILE_DAIMON_SOURCE_GROK_AUTH = previousDaimonGrokSource;
  await removeDirectory(homeDirectory).catch(() => undefined);
});

describe("consumeImageUp", () => {
  it("mounts direct Daimon sources from the embedded report before starting a sourceless image", async () => {
    const codex = path.join(homeDirectory, "codex.json"), grok = path.join(homeDirectory, "grok.json");
    await writeFile(codex, JSON.stringify({ tokens: { access_token: "fake-access", refresh_token: "fake-refresh" } }), { mode: 0o600 });
    await writeFile(grok, JSON.stringify({ "https://auth.x.ai::fixture": { key: "a".repeat(32), refresh_token: "r".repeat(16), expires_at: "2099-01-01T00:00:00.000Z" } }), { mode: 0o600 });
    process.env.SPAWNFILE_DAIMON_SOURCE_CODEX_AUTH = codex;
    process.env.SPAWNFILE_DAIMON_SOURCE_GROK_AUTH = grok;
    const state: FakeDockerState = { calls: [] };
    await consumeImageUp("you/org:v3", { deploymentName: "daimon-direct", runDocker: createFakeDocker(state, daimonReport()) });
    const run = state.calls.find((call) => call[0] === "run")!;
    expect(run).toContain(`${codex}:/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/coder/.daimon-inbound/codex-auth:ro`);
    expect(run).toContain(`${grok}:/var/lib/spawnfile/daimon/grok-bootstrap-auth:ro`);
  });

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
    expect(record.units[0]?.container_id).toBe(candidateContainerId);
    expect(record.units[0]?.contains).toContainEqual({ id: "dist_lab", kind: "network" });
    const cached = JSON.parse(await readHomeDeploymentReport("research"));
    expect(cached.version).toBe("spawnfile.distribution-report.v1");
  });

  it("routes a literal image up record into exact-id down", async () => {
    const state: FakeDockerState = { calls: [] };
    await consumeImageUp("you/org@sha256:" + "a".repeat(64), {
      authValues: { ANTHROPIC_API_KEY: "sk", DIST_REQUIRED_TOKEN: "x" },
      deploymentName: "lifecycle",
      runDocker: createFakeDocker(state)
    });
    const record = await readHomeDeploymentRecord("lifecycle");
    const unit = record.units[0]!;
    const calls: string[][] = [];
    await downDeployment({
      compiledOutputDirectory: path.join(homeDirectory, "unrelated-project"),
      deploymentName: "lifecycle",
      force: true,
      execFile: async (_file, args) => {
        calls.push(args);
        if (args.includes("inspect")) return { stderr: "", stdout: `${JSON.stringify(unit.container_id)}\n${JSON.stringify(`/${unit.container_name}`)}\n${JSON.stringify(unit.image_id)}\n${JSON.stringify({ "com.spawnfile.deployment": record.name, "com.spawnfile.compile_fingerprint": record.compile_fingerprint, "com.spawnfile.unit": unit.id })}\n` };
        return { stderr: "", stdout: "" };
      }
    });
    expect(calls.some((args) => args.includes("rm") && args.includes(unit.container_id!))).toBe(true);
    expect(calls.some((args) => args.includes(unit.container_name!))).toBe(false);
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

  it("fails closed when detached run output has no immutable container id", async () => {
    const state: FakeDockerState = { calls: [] };
    await expect(consumeImageUp("you/org:1.0.0", {
      authValues: { ANTHROPIC_API_KEY: "sk", DIST_REQUIRED_TOKEN: "x" },
      deploymentName: "empty-run-output",
      runDocker: createFakeDocker(state, undefined, { runOutput: "" })
    })).rejects.toThrow(/invalid identity/u);
    expect(state.calls.some((call) => call[0] === "rm" && call.includes("spawnfile-empty-run-output")))
      .toBe(false);
  });

  it("records no registry digest when image metadata has no digest-qualified ref", async () => {
    const state: FakeDockerState = { calls: [] };
    const base = createFakeDocker(state);
    const runDocker = async (args: string[]): Promise<Buffer> =>
      args[0] === "image" && args[1] === "inspect" && args.includes("{{json .RepoDigests}}")
        ? Buffer.from(JSON.stringify(["you/org:1.0.0"]))
        : base(args);
    await consumeImageUp("you/org:1.0.0", {
      authValues: { ANTHROPIC_API_KEY: "sk", DIST_REQUIRED_TOKEN: "x" },
      deploymentName: "missing-registry-digest",
      runDocker
    });
    const record = await readHomeDeploymentRecord("missing-registry-digest");
    expect(record.source.kind === "image" && record.source.digest).toBeNull();
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

  it("isolates exclusive realms across deployment lineages", async () => {
    const exclusiveReport = report([{
      durability: "persistent", id: "provider-subscription-realm", kind: "volume",
      lifecycle: "exclusive-reattach", target: "/var/lib/spawnfile/provider-realm"
    }]);
    const volumes: string[] = [];
    for (const deploymentName of ["blue", "green"]) {
      const state: FakeDockerState = { calls: [] };
      await consumeImageUp("you/org:1.0.0", {
        authValues: { ANTHROPIC_API_KEY: "sk", DIST_REQUIRED_TOKEN: "x" },
        deploymentName,
        runDocker: createFakeDocker(state, exclusiveReport)
      });
      const run = state.calls.find((call) => call[0] === "run")!;
      volumes.push(run[run.indexOf("-v") + 1]!.split(":")[0]!);
    }
    expect(volumes[0]).not.toBe(volumes[1]);
    expect(volumes[0]).toMatch(/^spawnfile-exclusive-provider-subscription-realm-[a-f0-9]{16}$/u);
  });

  it("refuses concurrent attachment of an exclusive realm by another deployment", async () => {
    const exclusiveReport = report([{
      durability: "persistent", id: "provider-subscription-realm", kind: "volume",
      lifecycle: "exclusive-reattach", target: "/var/lib/spawnfile/provider-realm"
    }]);
    const state: FakeDockerState = { calls: [] };
    const base = createFakeDocker(state, exclusiveReport);
    const runDocker = async (args: string[]): Promise<Buffer> => args[0] === "ps"
      ? Buffer.from("spawnfile-live\n")
      : base(args);
    await expect(consumeImageUp("you/org:1.0.0", {
      authValues: { ANTHROPIC_API_KEY: "sk", DIST_REQUIRED_TOKEN: "x" },
      deploymentName: "candidate",
      runDocker
    })).rejects.toThrow(/stop that deployment before reattaching/u);
    expect(state.calls.some((call) => call[0] === "run")).toBe(false);
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

  it("restores the previous container when a redeploy's new container fails to start", async () => {
    const calls: string[][] = [];
    const base = createFakeDocker({ calls: [] }, undefined, { liveExists: true });
    const runDocker = async (args: string[]): Promise<Buffer> => {
      calls.push(args);
      if (args[0] === "run") {
        throw new Error("new image crashed on boot");
      }
      return base(args);
    };
    await expect(
      consumeImageUp("you/org:1.0.0", {
        authValues: { ANTHROPIC_API_KEY: "sk", DIST_REQUIRED_TOKEN: "x" },
        deploymentName: "rollback",
        runDocker
      })
    ).rejects.toThrow(/crashed on boot/);

    const live = "spawnfile-rollback";
    const renames = calls.filter((c) => c[0] === "rename");
    // The live container was moved aside to a backup before the new run...
    const movedAside = renames.find((c) => c[1] === live);
    expect(movedAside).toBeDefined();
    const backup = movedAside![2]!;
    // ...and restored from that backup after the new container failed.
    expect(renames).toContainEqual(["rename", backup, live]);
    expect(calls).toContainEqual(["start", previousContainerId]);
    const restoredAt = calls.findIndex((c) => c[0] === "rename" && c[1] === backup && c[2] === live);
    expect(restoredAt).toBeGreaterThanOrEqual(0);
    // A failed run returned no verified candidate id, so rollback never deletes
    // the ambiguous deployment name.
    expect(calls.some((c) => c[0] === "rm" && c.includes(live))).toBe(false);
    // The backup (the previous deployment) is never force-removed on failure.
    expect(calls.some((c) => c[0] === "rm" && c.includes(backup))).toBe(false);
  });

  it("discards the previous container after a successful redeploy", async () => {
    const state: FakeDockerState = { calls: [] };
    await consumeImageUp("you/org:1.0.0", {
      authValues: { ANTHROPIC_API_KEY: "sk", DIST_REQUIRED_TOKEN: "x" },
      deploymentName: "swap",
      runDocker: createFakeDocker(state, undefined, { liveExists: true })
    });
    const live = "spawnfile-swap";
    const backup = state.calls.find((c) => c[0] === "rename" && c[1] === live)?.[2];
    expect(backup).toBeDefined();
    const readyAt = state.calls.findIndex((call) =>
      call[0] === "container" && call.some((arg) => arg.includes("{{json .State}}"))
    );
    const removedAt = state.calls.findIndex((call) =>
      call[0] === "rm" && call[1] === "-f" && call[2] === previousContainerId
    );
    expect(readyAt).toBeGreaterThanOrEqual(0);
    expect(removedAt).toBeGreaterThan(readyAt);
  });

  it("treats an indeterminate incumbent inspect as fatal without mutating by name", async () => {
    const calls: string[][] = [];
    const base = createFakeDocker({ calls: [] }, undefined, { liveExists: true });
    const runDocker = async (args: string[]): Promise<Buffer> => {
      calls.push(args);
      if (args[0] === "container" && args[1] === "inspect"
        && args[args.length - 1] === "spawnfile-inspect-unknown") {
        throw new Error("daemon transport unavailable");
      }
      return base(args);
    };
    await expect(consumeImageUp("you/org:1.0.0", {
      authValues: { ANTHROPIC_API_KEY: "sk", DIST_REQUIRED_TOKEN: "x" },
      deploymentName: "inspect-unknown",
      runDocker
    })).rejects.toThrow(/Unable to determine container identity state/u);
    expect(calls.some((call) => ["rename", "stop"].includes(call[0]!))).toBe(false);
    expect(calls.some((call) => call[0] === "rm" && call.includes("spawnfile-inspect-unknown")))
      .toBe(false);
    expect(calls.some((call) => call[0] === "run" && call.includes("-d"))).toBe(false);
  });

  it("restores and re-verifies the incumbent when stop fails after taking effect", async () => {
    const calls: string[][] = [];
    const base = createFakeDocker({ calls: [] }, undefined, { liveExists: true });
    const runDocker = async (args: string[]): Promise<Buffer> => {
      calls.push(args);
      if (args[0] === "stop") {
        await base(args);
        throw new Error("stop acknowledgement lost");
      }
      return base(args);
    };
    await expect(consumeImageUp("you/org:1.0.0", {
      authValues: { ANTHROPIC_API_KEY: "sk", DIST_REQUIRED_TOKEN: "x" },
      deploymentName: "stop-rollback",
      runDocker
    })).rejects.toThrow(/stop acknowledgement lost/u);
    const live = "spawnfile-stop-rollback";
    const backup = calls.find((call) => call[0] === "rename" && call[1] === live)?.[2];
    expect(backup).toBeDefined();
    expect(calls).toContainEqual(["rename", backup!, live]);
    expect(calls).toContainEqual(["start", previousContainerId]);
    expect(calls.some((call) => call[0] === "run")).toBe(false);
  });

  it("restores the previous container when candidate readiness inspection fails", async () => {
    const calls: string[][] = [];
    const base = createFakeDocker({ calls: [] }, undefined, { liveExists: true });
    const runDocker = async (args: string[]): Promise<Buffer> => {
      calls.push(args);
      if (args[0] === "container" && args.some((arg) => arg.includes("{{json .State}}"))) {
        throw new Error("readiness transport failed");
      }
      return base(args);
    };
    await expect(consumeImageUp("you/org:1.0.0", {
      authValues: { ANTHROPIC_API_KEY: "sk", DIST_REQUIRED_TOKEN: "x" },
      deploymentName: "readiness-rollback",
      runDocker
    })).rejects.toThrow(/readiness transport failed/u);

    const live = "spawnfile-readiness-rollback";
    const backup = calls.find((call) => call[0] === "rename" && call[1] === live)?.[2];
    expect(backup).toBeDefined();
    const candidateRemovedAt = calls.findIndex((call) =>
      call[0] === "rm" && call[1] === "-f" && call[2] === candidateContainerId
    );
    const restoredAt = calls.findIndex((call) =>
      call[0] === "rename" && call[1] === backup && call[2] === live
    );
    expect(candidateRemovedAt).toBeGreaterThanOrEqual(0);
    expect(restoredAt).toBeGreaterThan(candidateRemovedAt);
    expect(calls).toContainEqual(["start", previousContainerId]);
    expect(calls.some((call) => call[0] === "rm" && call.includes(backup!))).toBe(false);
  });

  it("reports the previous ref/digest when explicitly redeploying", async () => {
    const auth = { ANTHROPIC_API_KEY: "sk", DIST_REQUIRED_TOKEN: "x" };
    const first = await consumeImageUp("you/org:1.0.0", {
      authValues: auth,
      deploymentName: "evolve",
      runDocker: createFakeDocker({ calls: [] })
    });
    expect(first.previous).toBeNull();

    const second = await consumeImageUp("you/org:2.0.0", {
      authValues: auth,
      deploymentName: "evolve",
      runDocker: createFakeDocker({ calls: [] }, undefined, { liveExists: true })
    });
    expect(second.previous?.ref).toBe("you/org:1.0.0");
  });

  it("names the derived deployment when an implicit-name redeploy collides", async () => {
    const auth = { ANTHROPIC_API_KEY: "sk", DIST_REQUIRED_TOKEN: "x" };
    await consumeImageUp("you/org:1.0.0", {
      authValues: auth,
      deploymentName: "org",
      runDocker: createFakeDocker({ calls: [] })
    });
    // No --deployment: the name is derived as "org" and already exists.
    await expect(
      consumeImageUp("you/org:1.0.0", {
        authValues: auth,
        runDocker: createFakeDocker({ calls: [] })
      })
    ).rejects.toThrow(/already exists \(derived from image you\/org:1.0.0\).*--deployment org/s);
  });

  it("refuses a concurrent operation on the same deployment via the lock", async () => {
    const { acquireHomeDeploymentLock } = await import("../deployment/index.js");
    const release = await acquireHomeDeploymentLock("locked");
    try {
      await expect(
        consumeImageUp("you/org:1.0.0", {
          authValues: { ANTHROPIC_API_KEY: "sk", DIST_REQUIRED_TOKEN: "x" },
          deploymentName: "locked",
          runDocker: createFakeDocker({ calls: [] })
        })
      ).rejects.toThrow(/already being modified/);
    } finally {
      await release();
    }
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
