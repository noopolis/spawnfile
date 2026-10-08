import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { ensureDirectory, readUtf8File, removeDirectory, writeUtf8File } from "../filesystem/index.js";
import { DAIMON_CONTRACT_MANIFEST_SHA256 } from "../runtime/daimon/contractManifest.js";

import { buildCompilePlan } from "./buildCompilePlan.js";
import { compileProject } from "./compileProject.js";

/**
 * Proves S2 + S2b + S3 end to end: an organization whose members inherit one shared
 * MCP server, select their own tools, opt in to an `opt_in` shared server
 * (only the writer lists `checker`; the editor never receives it) and use `${workspace}` / `${agent.*}`
 * placeholders compiles to the byte-identical Daimon config that the same
 * organization spelled out long-hand (absolute container paths, literal
 * per-agent identity) produces.
 */
const temporaryDirectories: string[] = [];
const AGENT_ROOT = "/var/lib/spawnfile/instances/daimon/daimon-organization/workspace/agents";
const CONFIG_PATH = "container/rootfs/var/lib/spawnfile/instances/daimon/daimon-organization/daimon/daimon-organization-runtime.json";

const makeTemporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const useCompatibleDaimonRuntime = async (): Promise<void> => {
  const identityPath = path.join(await makeTemporaryDirectory("spawnfile-mcp-daimon-"), "identity.json");
  const digest = `sha256:${"a".repeat(64)}`;
  await writeUtf8File(identityPath, `${JSON.stringify({
    capability_receipt_sha256: digest,
    development: { mode: "local-development", non_production: true, unpublished: true, unsigned: true },
    image_architecture: "amd64",
    image_config_digest: digest,
    image_manifest_digest: digest,
    image_reference: `127.0.0.1:54321/noopolis/spawnfile-runtime-daimon@${digest}`,
    manifest_sha256: DAIMON_CONTRACT_MANIFEST_SHA256,
    registry_authority: "127.0.0.1:54321",
    version: "spawnfile.local-daimon-runtime-identity.v3"
  })}\n`);
  process.env.SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY = identityPath;
};

afterEach(async () => {
  delete process.env.SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

const TEAM_HEADER = ['spawnfile_version: "0.1"', "kind: team", "name: studio", "mode: swarm"];
const MEMBERS = ["members:", "  - { id: writer, ref: agents/writer }", "  - { id: editor, ref: agents/editor }"];

const SHORT_TEAM = [
  ...TEAM_HEADER,
  "shared:",
  "  environment:",
  "    mcp_servers:",
  "      - name: workbench",
  "        transport: stdio",
  "        command: /usr/local/bin/node",
  "        args: [\"${workspace}/tools/workbench/server.mjs\"]",
  "        env:",
  "          WORKBENCH_AGENT: \"${agent.name}\"",
  "          WORKBENCH_AGENT_ID: \"${agent.id}\"",
  "          WORKBENCH_STATE_ROOT: \"${workspace}/state/shared\"",
  "          WORKBENCH_CONTROL_URL: http://127.0.0.1:19700",
  "        tools: [read_item]",
  "      - name: checker",
  "        opt_in: true",
  "        transport: stdio",
  "        command: /usr/local/bin/node",
  "        args: [\"${workspace}/tools/checker/server.mjs\"]",
  "        env: { CHECKER_AGENT: \"${agent.name}\" }",
  "        tools: [check_item]",
  ...MEMBERS
];

const SHORT_AGENTS: Record<string, string[]> = {
  editor: [
    "  mcp_servers:",
    "    - name: workbench",
    "      tools: [approve_item]",
    "      env: { WORKBENCH_EXTRA_ROOT: \"${workspace}/extra\" }"
  ],
  writer: [
    "  mcp_servers:",
    "    - { name: workbench, tools: [file_item, read_item] }",
    "    - name: checker"
  ]
};

const longWorkbench = (agent: string, tools: string, extraEnv = ""): string[] => [
  "    - name: workbench",
  "      transport: stdio",
  "      command: /usr/local/bin/node",
  `      args: [${AGENT_ROOT}/${agent}/tools/workbench/server.mjs]`,
  "      env:",
  `        WORKBENCH_AGENT: ${agent}`,
  `        WORKBENCH_AGENT_ID: "agent:${agent}"`,
  `        WORKBENCH_STATE_ROOT: ${AGENT_ROOT}/${agent}/state/shared`,
  "        WORKBENCH_CONTROL_URL: http://127.0.0.1:19700",
  ...(extraEnv ? [extraEnv] : []),
  `      tools: [${tools}]`
];

const LONG_AGENTS: Record<string, string[]> = {
  editor: [
    "  mcp_servers:",
    ...longWorkbench("editor", "approve_item", `        WORKBENCH_EXTRA_ROOT: ${AGENT_ROOT}/editor/extra`)
  ],
  writer: [
    "  mcp_servers:",
    ...longWorkbench("writer", "file_item, read_item"),
    "    - name: checker",
    "      transport: stdio",
    "      command: /usr/local/bin/node",
    `      args: [${AGENT_ROOT}/writer/tools/checker/server.mjs]`,
    "      env: { CHECKER_AGENT: writer }",
    "      tools: [check_item]"
  ]
};

const writeOrganization = async (team: string[], agents: Record<string, string[]>): Promise<string> => {
  const directory = await makeTemporaryDirectory("spawnfile-mcp-org-");
  await writeUtf8File(path.join(directory, "Spawnfile"), `${team.join("\n")}\n`);
  for (const [name, mcpLines] of Object.entries(agents)) {
    await ensureDirectory(path.join(directory, "agents", name));
    await writeUtf8File(path.join(directory, "agents", name, "AGENTS.md"), `# ${name}\n`);
    await writeUtf8File(path.join(directory, "agents", name, "Spawnfile"), [
      'spawnfile_version: "0.1"',
      "kind: agent",
      `name: ${name}`,
      "runtime: daimon",
      "workspace: { docs: { system: AGENTS.md } }",
      "environment:",
      ...mcpLines,
      ""
    ].join("\n"));
  }
  return directory;
};

const compileDaimonConfig = async (projectDirectory: string): Promise<string> => {
  const outputDirectory = await makeTemporaryDirectory("spawnfile-mcp-out-");
  await compileProject(projectDirectory, { outputDirectory });
  return readUtf8File(path.join(outputDirectory, CONFIG_PATH));
};

describe("shared MCP inheritance with per-agent placeholders", () => {
  it("compiles to the same Daimon config as the long-hand organization", async () => {
    await useCompatibleDaimonRuntime();
    const shortConfig = await compileDaimonConfig(await writeOrganization(SHORT_TEAM, SHORT_AGENTS));
    const longConfig = await compileDaimonConfig(
      await writeOrganization([...TEAM_HEADER, ...MEMBERS], LONG_AGENTS)
    );

    expect(shortConfig).toBe(longConfig);
    const writer = (JSON.parse(shortConfig) as { agents: Array<{ id: string; mcp: unknown[] }> })
      .agents.find((agent) => agent.id === "agent:writer");
    expect(writer?.mcp[0]).toMatchObject({
      args: [`${AGENT_ROOT}/writer/tools/workbench/server.mjs`],
      env: { WORKBENCH_AGENT: "writer", WORKBENCH_AGENT_ID: "agent:writer" },
      tools: ["file_item", "read_item"]
    });
  }, 60_000);

  it("names the agent when an override has no inherited server", async () => {
    const directory = await writeOrganization([...TEAM_HEADER, ...MEMBERS], {
      editor: ["  mcp_servers:", "    - { name: workbench, tools: [approve_item] }"],
      writer: ["  env: {}"]
    });

    await expect(buildCompilePlan(directory)).rejects.toThrow(
      "Agent editor overrides MCP server workbench, but its team declares no shared.environment.mcp_servers entry named workbench"
    );
  });
});
