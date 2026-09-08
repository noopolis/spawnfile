import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeDirectory } from "../filesystem/index.js";

import { buildDistributionReport } from "./buildDistributionReport.js";
import { consumeImageUp } from "./consumeImage.js";
import { DISTRIBUTION_REPORT_IMAGE_PATH } from "./types.js";
import type { DistributionRuntimeInstance } from "./types.js";

const previousHome = process.env.SPAWNFILE_HOME;
const previousDaimonCodexSource = process.env.SPAWNFILE_DAIMON_SOURCE_CODEX_AUTH;
let homeDirectory: string;

const candidateContainerId = "c".repeat(64);
const daimonConfigPath = "/var/lib/spawnfile/instances/daimon/daimon-organization/daimon/daimon-organization-runtime.json";

const strictCodexAgent = (id = "agent:coder") => ({
  engine: {
    codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" },
    kind: "codex"
  },
  id,
  name: id.split(":").pop() ?? id,
  runtimeHomePath: `/var/lib/spawnfile/runtime-homes/${id.replace(/[^a-z0-9]/giu, "-")}`,
  workspacePath: `/var/lib/spawnfile/workspaces/${id.replace(/[^a-z0-9]/giu, "-")}`
});

const mutatedCodexAgent = (id = "agent:mutated") => ({
  ...strictCodexAgent(id),
  engine: {
    codexSandbox: { mode: "workspace-write", networkAccess: true, webSearch: "disabled" },
    kind: "codex"
  }
});

const daimonConfig = (agents: unknown[] = [strictCodexAgent()]) => ({
  agents,
  host: {},
  version: "noopolis.daimon.organization-runtime.v1"
});

const daimonInstance = (
  id = "daimon-organization",
  nodeIds = ["agent:coder"],
  configPath = daimonConfigPath
): DistributionRuntimeInstance => ({
  config_path: configPath,
  engine_by_node_id: Object.fromEntries(nodeIds.map((nodeId) => [nodeId, "codex"])),
  home_path: null,
  id,
  internal_port: null,
  model_auth_methods: {},
  model_secrets_required: [],
  node_ids: nodeIds,
  published_port: null,
  runtime: "daimon",
  workspace_path: `/var/lib/spawnfile/instances/daimon/${id}/workspace`
});

const imageReport = (instances: DistributionRuntimeInstance[] = [daimonInstance()]) =>
  buildDistributionReport({
    envVariables: [], generatedAt: "2026-08-26T00:00:00.000Z", internalPorts: [],
    modelAuthMethods: {}, moltnetNetworks: [],
    organization: { agents: instances.flatMap((instance) =>
      instance.node_ids.map((id) => ({ id, name: id.replace(/^agent:/u, ""), runtime: "daimon", teams: [] }))
    ), project: "distribution-org", teams: [] },
    persistentMounts: [], portMappings: [], publishedPorts: [], resources: [],
    runtimeInstances: instances
  });

const nonDaimonReport = () => buildDistributionReport({
  envVariables: [], generatedAt: "2026-08-26T00:00:00.000Z", internalPorts: [],
  modelAuthMethods: {}, moltnetNetworks: [],
  organization: { agents: [{ id: "agent:a", name: "a", runtime: "picoclaw", teams: [] }], project: "distribution-org", teams: [] },
  persistentMounts: [], portMappings: [], publishedPorts: [], resources: [],
  runtimeInstances: [{
    config_path: "/c", home_path: null, id: "picoclaw-a", internal_port: null,
    model_auth_methods: {}, model_secrets_required: [], node_ids: ["agent:a"],
    published_port: null, runtime: "picoclaw", workspace_path: "/w"
  }]
});

const buildTar = (content: Buffer, name = "payload.json"): Buffer => {
  const header = Buffer.alloc(512);
  header.write(name, 0, "ascii");
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("0", 156, "ascii");
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(padded);
  return Buffer.concat([header, padded, Buffer.alloc(1024)]);
};

const dockerSecurityPostureArgs = (args: string[]): string[] =>
  args.filter((arg) => arg.startsWith("--cap-") || arg.startsWith("--security-opt"));

const createFakeDocker = (
  calls: string[][],
  report = imageReport(),
  configByPath: Record<string, unknown> = { [daimonConfigPath]: daimonConfig() }
) => {
  let startedName: string | null = null;
  return async (args: string[]): Promise<Buffer> => {
    calls.push(args);
    if (args[0] === "image" && args[1] === "inspect" && args.includes("{{json .Config.Labels}}")) {
    return Buffer.from(JSON.stringify({
      "com.spawnfile.compile_fingerprint": report.compile_fingerprint,
      "com.spawnfile.image_contract": "spawnfile.image.v1",
      "com.spawnfile.project": "distribution-org",
      "com.spawnfile.report": DISTRIBUTION_REPORT_IMAGE_PATH
    }));
  }
    if (args[0] === "cp") {
    const source = args[1] ?? "";
    const copiedPath = source.includes(":") ? source.slice(source.indexOf(":") + 1) : source;
    if (copiedPath === DISTRIBUTION_REPORT_IMAGE_PATH) {
      return buildTar(Buffer.from(JSON.stringify(report)), "spawnfile-report.json");
    }
    if (Object.prototype.hasOwnProperty.call(configByPath, copiedPath)) {
      const value = configByPath[copiedPath]!;
      return buildTar(Buffer.from(typeof value === "string" ? value : JSON.stringify(value)));
    }
    throw new Error(`No such file in image: ${copiedPath}`);
  }
    if (args[0] === "container" && args[1] === "inspect") {
    const reference = args[args.length - 1]!;
    if (!startedName || (reference !== candidateContainerId && reference !== startedName)) {
      throw new Error("No such container");
    }
    const format = args[args.indexOf("--format") + 1] ?? "";
    if (format.includes("{{json .State}}")) {
      return Buffer.from([
        JSON.stringify(candidateContainerId), JSON.stringify(`/${startedName}`),
        JSON.stringify({ Running: true, Status: "running" })
      ].join("\n"));
    }
    return Buffer.from([
      JSON.stringify(candidateContainerId), JSON.stringify(`/${startedName}`), JSON.stringify(true)
    ].join("\n"));
  }
    if (args[0] === "image" && args[1] === "inspect" && args.includes("{{.Id}}")) {
    return Buffer.from("sha256:localimage");
  }
    if (args[0] === "image" && args[1] === "inspect" && args.includes("{{json .RepoDigests}}")) {
    return Buffer.from(JSON.stringify(["you/org@sha256:remotedigest"]));
  }
    if (args[0] === "run") {
    const nameIndex = args.indexOf("--name");
    startedName = nameIndex >= 0 ? args[nameIndex + 1]! : null;
    return Buffer.from(`${candidateContainerId}\n`);
  }
    if (args[0] === "rm") return Buffer.from("");
    return Buffer.from("");
  };
};

beforeEach(async () => {
  homeDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-consume-daimon-test-"));
  process.env.SPAWNFILE_HOME = homeDirectory;
  const codex = path.join(homeDirectory, "codex.json");
  await writeFile(codex, JSON.stringify({ tokens: { access_token: "fake-access", refresh_token: "fake-refresh" } }), { mode: 0o600 });
  process.env.SPAWNFILE_DAIMON_SOURCE_CODEX_AUTH = codex;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = previousHome;
  if (previousDaimonCodexSource === undefined) delete process.env.SPAWNFILE_DAIMON_SOURCE_CODEX_AUTH;
  else process.env.SPAWNFILE_DAIMON_SOURCE_CODEX_AUTH = previousDaimonCodexSource;
  await removeDirectory(homeDirectory).catch(() => undefined);
});

describe("Daimon Docker posture for image consumption", () => {
  it("adds baseline posture and strict Codex native sandbox opts", async () => {
    const calls: string[][] = [];
    await consumeImageUp("you/org:v3", {
      daimonContainerCredentialUid: process.getuid?.(),
      deploymentName: "daimon-strict",
      runDocker: createFakeDocker(calls)
    });

    const run = calls.find((call) => call[0] === "run")!;
    expect(dockerSecurityPostureArgs(run)).toEqual([
      "--cap-drop=ALL", "--cap-add=CHOWN", "--cap-add=SETUID", "--cap-add=SETGID",
      "--cap-add=DAC_READ_SEARCH", "--cap-add=SETPCAP", "--cap-add=KILL",
      "--security-opt=no-new-privileges:true", "--security-opt=seccomp=unconfined",
      "--security-opt=apparmor=unconfined"
    ]);
  });

  it("leaves non-Daimon image run args unchanged", async () => {
    const calls: string[][] = [];
    await consumeImageUp("you/org:v3", {
      deploymentName: "picoclaw-image",
      runDocker: createFakeDocker(calls, nonDaimonReport())
    });

    const run = calls.find((call) => call[0] === "run")!;
    expect(dockerSecurityPostureArgs(run)).toEqual([]);
  });

  it("keeps strict Codex interop opts off for non-strict Daimon configs", async () => {
    const calls: string[][] = [];
    await consumeImageUp("you/org:v3", {
      daimonContainerCredentialUid: process.getuid?.(),
      deploymentName: "daimon-nonstrict",
      runDocker: createFakeDocker(calls, imageReport(), {
        [daimonConfigPath]: daimonConfig([{ ...strictCodexAgent(), engine: { kind: "codex" } }])
      })
    });

    const run = calls.find((call) => call[0] === "run")!;
    expect(dockerSecurityPostureArgs(run)).toEqual([
      "--cap-drop=ALL", "--cap-add=CHOWN", "--cap-add=SETUID", "--cap-add=SETGID",
      "--cap-add=DAC_READ_SEARCH", "--cap-add=SETPCAP", "--cap-add=KILL",
      "--security-opt=no-new-privileges:true"
    ]);
  });

  it("validates later agents after a strict Codex image agent requires interop", async () => {
    const calls: string[][] = [];
    await expect(consumeImageUp("you/org:v3", {
      daimonContainerCredentialUid: process.getuid?.(),
      deploymentName: "daimon-later-agent",
      runDocker: createFakeDocker(calls, imageReport(), {
        [daimonConfigPath]: daimonConfig([strictCodexAgent(), mutatedCodexAgent()])
      })
    })).rejects.toMatchObject({
      code: "validation_error",
      message: "Daimon Codex sandbox policy is not the supported strict workspace-no-network policy"
    });
    expect(calls.some((call) => ["container", "rename", "run", "stop"].includes(call[0]!))).toBe(false);
  });

  it("validates later instances after an earlier image instance requires interop", async () => {
    const secondConfigPath = "/var/lib/spawnfile/instances/daimon/daimon-secondary/daimon/daimon-organization-runtime.json";
    const calls: string[][] = [];
    await expect(consumeImageUp("you/org:v3", {
      daimonContainerCredentialUid: process.getuid?.(),
      deploymentName: "daimon-later-instance",
      runDocker: createFakeDocker(calls, imageReport([
        daimonInstance(), daimonInstance("daimon-secondary", ["agent:secondary"], secondConfigPath)
      ]), {
        [daimonConfigPath]: daimonConfig([strictCodexAgent()]),
        [secondConfigPath]: daimonConfig([mutatedCodexAgent("agent:secondary")])
      })
    })).rejects.toMatchObject({
      code: "validation_error",
      message: "Daimon Codex sandbox policy is not the supported strict workspace-no-network policy"
    });
    expect(calls.some((call) => ["container", "rename", "run", "stop"].includes(call[0]!))).toBe(false);
  });
});
