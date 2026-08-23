import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { removeDirectory, writeUtf8File } from "../filesystem/index.js";
import { writeDeploymentRecord, type DeploymentRecord } from "../deployment/index.js";
import type { CompileReport } from "../report/index.js";

import { buildUpReceipt, resolveCompiledEngines, resolveCompiledSchedule } from "./upReceipt.js";
import type { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";
import type { UpProjectResult } from "./upProject.js";
import type { OrganizationReadinessEvidence } from "./organizationReadyEvidence.js";

const temporaryDirectories: string[] = [];
const genericOrganizationReadinessEvidence: OrganizationReadinessEvidence = {
  compileFingerprint: "sf1:000000000000", compileVersion: "0.1", hasExternalMoltnet: false,
  networks: [], organizationMembers: [], projectLabel: "generic",
  version: "spawnfile.organization-ready-evidence.v1", worldBindings: null
};

const createTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

const createAgentNode = (
  id: string,
  schedule: ResolvedAgentNode["schedule"]
): CompilePlan["nodes"][number] => ({
  id,
  kind: "agent",
  runtimeName: "openclaw",
  slug: id,
  value: {
    description: "",
    docs: [],
    env: {},
    execution: undefined,
    kind: "agent",
    mcpServers: [],
    name: id,
    policyMode: null,
    policyOnDegrade: null,
    runtime: { name: "openclaw", options: {} },
    schedule,
    secrets: [],
    skills: [],
    source: `/tmp/${id}/Spawnfile`,
    subagents: []
  } satisfies ResolvedAgentNode
});

const createTeamNode = (id: string): CompilePlan["nodes"][number] => ({
  id,
  kind: "team",
  runtimeName: null,
  slug: id,
  value: {
    description: "",
    docs: [],
    external: [],
    kind: "team",
    lead: null,
    members: [],
    mode: "swarm",
    name: id,
    policyMode: null,
    policyOnDegrade: null,
    shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
    source: `/tmp/${id}/Spawnfile`
  } satisfies ResolvedTeamNode
});

describe("resolveCompiledSchedule", () => {
  it("extracts only cron-kind schedules, sorted by agent id", () => {
    const plan: CompilePlan = {
      edges: [],
      nodes: [
        createAgentNode("agent:zeta", { cron: "0 6 * * *", kind: "cron" }),
        createAgentNode("agent:alpha", { cron: "0 5 * * *", kind: "cron" }),
        createAgentNode("agent:no-schedule", undefined),
        createAgentNode("agent:disabled", { kind: "disabled" }),
        createAgentNode("agent:every", { every: "30m", kind: "every" }),
        createTeamNode("team:root")
      ],
      root: "/tmp/Spawnfile",
      runtimes: { openclaw: { nodeIds: [] } }
    };

    expect(resolveCompiledSchedule(plan)).toEqual([
      { agent: "agent:alpha", cron: "0 5 * * *" },
      { agent: "agent:zeta", cron: "0 6 * * *" }
    ]);
  });

  it("returns an empty array when no agent declares a cron schedule", () => {
    const plan: CompilePlan = {
      edges: [],
      nodes: [createAgentNode("agent:solo", undefined)],
      root: "/tmp/Spawnfile",
      runtimes: { openclaw: { nodeIds: [] } }
    };

    expect(resolveCompiledSchedule(plan)).toEqual([]);
  });
});

describe("resolveCompiledEngines", () => {
  it("flattens engine_by_node_id off every runtime instance, sorted by agent id", () => {
    const report: CompileReport = {
      ...createReport(),
      container: {
        ...createReport().container!,
        runtime_instances: [
          {
            config_path: "/var/lib/spawnfile/instances/pi/pi-app/pi/pi-app.json",
            engine_by_node_id: { "agent:sam": "grok", "agent:eleanor": "scripted" },
            home_path: "/var/lib/spawnfile/instances/pi/pi-app/home",
            id: "pi-app",
            model_auth_methods: {},
            model_secrets_required: [],
            runtime: "pi"
          }
        ]
      }
    };

    expect(resolveCompiledEngines(report)).toEqual([
      { agent: "agent:eleanor", engine: "scripted" },
      { agent: "agent:sam", engine: "grok" }
    ]);
  });

  it("returns an empty array when no runtime instance discloses an engine (e.g. openclaw)", () => {
    expect(resolveCompiledEngines(createReport())).toEqual([]);
  });
});

const createSingleAgentFixture = async (): Promise<string> => {
  const directory = await createTempDirectory("spawnfile-up-receipt-fixture-");
  await writeUtf8File(path.join(directory, "AGENTS.md"), "# Agent\n");
  await writeUtf8File(path.join(directory, "IDENTITY.md"), "# Identity\n");
  await writeUtf8File(path.join(directory, "SOUL.md"), "# Soul\n");
  await writeUtf8File(
    path.join(directory, "Spawnfile"),
    [
      'spawnfile_version: "0.1"',
      "kind: agent",
      "name: analyst",
      "",
      "runtime: openclaw",
      "",
      "schedule:",
      "  kind: cron",
      '  cron: "0 5 * * *"',
      "",
      "execution:",
      "  model:",
      "    primary:",
      "      provider: anthropic",
      "      name: claude-sonnet-4-5",
      "  sandbox:",
      "    mode: workspace",
      "",
      "workspace:",
      "  docs:",
      "    identity: IDENTITY.md",
      "    soul: SOUL.md",
      "    system: AGENTS.md",
      "",
      "policy:",
      "  mode: warn",
      "  on_degrade: warn",
      ""
    ].join("\n")
  );
  return directory;
};

const createRecord = (overrides: Partial<DeploymentRecord> = {}): DeploymentRecord => ({
  auth_profile: null,
  compile_fingerprint: "sf1:abc123",
  created_at: "2026-07-11T00:00:00.000Z",
  manager: "docker",
  name: "default",
  output_directory: "/project/.spawn",
  run_id: "run-abc123",
  source: { kind: "project", root: "/project" },
  target: { endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef", kind: "context", name: "default" },
  units: [
    {
      container_id: "container-123",
      container_name: "spawnfile-project",
      contains: [{ id: "agent:analyst", kind: "agent" }],
      id: "default-container",
      image_id: "image-123",
      image_tag: "spawnfile-project:latest",
      kind: "container",
      runtime_instances: ["agent-analyst"]
    }
  ],
  version: "spawnfile.deployment.v2",
  ...overrides
});

const createReport = (): CompileReport => ({
  compile_fingerprint: "sf1:abc123",
  container: {
    dockerfile: "container/Dockerfile",
    entrypoint: "container/entrypoint",
    env_example: "container/.env.example",
    model_secrets_required: [],
    moltnet: {
      node_plans: [],
      release: {
        architecture: "amd64",
        asset: "moltnet_linux_amd64.tar.gz",
        asset_sha256: `sha256:${"b".repeat(64)}`,
        capabilities: ["pi-bridge"],
        release_version: "v0.1.14-1-gaaaaaaa",
        source_revision: "a".repeat(40),
        version: "spawnfile.moltnet-release-identity.v1"
      },
      server_plans: [
        { base_url: "http://127.0.0.1:8787", id: "root-office_lab", mode: "managed", network_id: "office_lab", rooms: [] }
      ]
    },
    ports: [],
    runtime_homes: [],
    runtime_instances: [],
    runtime_secrets_required: [],
    runtimes_installed: ["openclaw"],
    secrets_required: []
  },
  diagnostics: [],
  nodes: [],
  root: "/project",
  spawnfile_version: "0.1"
});

const createUpResult = (
  outputDirectory: string,
  deploymentRecordPath: string | null
): UpProjectResult => ({
  authProfileName: null,
  containerName: "spawnfile-project",
  deploymentRecordPath,
  imageTag: "spawnfile-project:latest",
  organizationReadinessEvidence: genericOrganizationReadinessEvidence,
  outputDirectory,
  report: createReport(),
  reportPath: path.join(outputDirectory, "spawnfile-report.json"),
  supportDirectory: null
});

describe("buildUpReceipt", () => {
  it("builds a conformant spawnfile.up-receipt.v1, reading back run_id/container id from the deployment record", async () => {
    const fixtureDirectory = await createSingleAgentFixture();
    const outputDirectory = await createTempDirectory("spawnfile-up-receipt-compiled-");
    const recordPath = await writeDeploymentRecord(outputDirectory, createRecord());

    const receipt = await buildUpReceipt(fixtureDirectory, createUpResult(outputDirectory, recordPath));

    expect(receipt.version).toBe("spawnfile.up-receipt.v1");
    expect(receipt.run_id).toBe("run-abc123");
    expect(receipt.fingerprint).toBe("sf1:abc123");
    expect(receipt.deployment).toEqual({ container_ids: ["container-123"], name: "default" });
    expect(receipt.readiness).toEqual({
      moltnet_base_url: "http://127.0.0.1:8787",
      state: "running"
    });
    expect(receipt.compiled_schedule).toEqual([{ agent: "agent:analyst", cron: "0 5 * * *" }]);
    expect(receipt.engines).toEqual([]);
    expect(receipt.moltnet_release).toMatchObject({
      capabilities: ["pi-bridge"],
      release_version: "v0.1.14-1-gaaaaaaa"
    });
  });

  it("discloses a scripted pi engine per agent, derived from the compile report's engine_by_node_id", async () => {
    const fixtureDirectory = await createSingleAgentFixture();
    const outputDirectory = await createTempDirectory("spawnfile-up-receipt-compiled-");
    const upResult = createUpResult(outputDirectory, null);
    upResult.report = {
      ...upResult.report,
      container: {
        ...upResult.report.container!,
        runtime_instances: [
          {
            config_path: "/var/lib/spawnfile/instances/pi/pi-app/pi/pi-app.json",
            engine_by_node_id: { "agent:eleanor": "scripted" },
            home_path: "/var/lib/spawnfile/instances/pi/pi-app/home",
            id: "pi-app",
            model_auth_methods: {},
            model_secrets_required: [],
            runtime: "pi"
          }
        ]
      }
    };

    const receipt = await buildUpReceipt(fixtureDirectory, upResult);

    expect(receipt.engines).toEqual([{ agent: "agent:eleanor", engine: "scripted" }]);
  });

  it("preserves an explicit local dual-bridge Moltnet identity without relabeling it as public", async () => {
    const fixtureDirectory = await createSingleAgentFixture();
    const outputDirectory = await createTempDirectory("spawnfile-up-receipt-compiled-");
    const upResult = createUpResult(outputDirectory, null);
    upResult.report = {
      ...upResult.report,
      container: {
        ...upResult.report.container!,
        moltnet: {
          ...upResult.report.container!.moltnet!,
          release: {
            architecture: "amd64", asset: "moltnet_linux_amd64.tar.gz",
            asset_sha256: `sha256:${"d".repeat(64)}`,
            capabilities: ["daimon-bridge", "pi-bridge"],
            development: { mode: "local-development", non_production: true, unsigned: true, unpublished: true },
            source_sha256: `sha256:${"e".repeat(64)}`,
            version: "spawnfile.moltnet-release-identity.v1"
          }
        }
      }
    };

    const receipt = await buildUpReceipt(fixtureDirectory, upResult);

    expect(receipt.moltnet_release).toEqual({
      architecture: "amd64", asset: "moltnet_linux_amd64.tar.gz",
      asset_sha256: `sha256:${"d".repeat(64)}`,
      capabilities: ["daimon-bridge", "pi-bridge"],
      development: { mode: "local-development", non_production: true, unsigned: true, unpublished: true },
      source_sha256: `sha256:${"e".repeat(64)}`,
      version: "spawnfile.moltnet-release-identity.v1"
    });
  });

  it("reports unknown readiness and null deployment name with no deployment record (non-detached run)", async () => {
    const fixtureDirectory = await createSingleAgentFixture();
    const outputDirectory = await createTempDirectory("spawnfile-up-receipt-compiled-");

    const receipt = await buildUpReceipt(fixtureDirectory, createUpResult(outputDirectory, null));

    expect(receipt.run_id).toBeNull();
    expect(receipt.deployment).toEqual({ container_ids: [], name: null });
    expect(receipt.readiness.state).toBe("unknown");
  });

  it("refuses to build a receipt when the compiled report has no compile_fingerprint", async () => {
    const fixtureDirectory = await createSingleAgentFixture();
    const outputDirectory = await createTempDirectory("spawnfile-up-receipt-compiled-");
    const upResult = createUpResult(outputDirectory, null);
    delete (upResult.report as { compile_fingerprint?: string }).compile_fingerprint;

    await expect(buildUpReceipt(fixtureDirectory, upResult)).rejects.toThrow(/no compile_fingerprint/);
  });
});
