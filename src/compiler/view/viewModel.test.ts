import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { ensureDirectory, removeDirectory, writeUtf8File } from "../../filesystem/index.js";
import { buildOrganizationView } from "./buildOrganizationView.js";
import { renderOrganizationNetworks } from "./renderNetworks.js";
import { renderOrganizationTree } from "./renderTree.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

const writeAgent = async (
  directory: string,
  name: string,
  policy: string
): Promise<void> => {
  await ensureDirectory(directory);
  await writeUtf8File(path.join(directory, "Spawnfile"), [
    'spawnfile_version: "0.1"',
    "kind: agent",
    `name: ${name}`,
    "runtime: openclaw",
    "surfaces:",
    "  moltnet:",
    "    - network: shared",
    "      rooms:",
    "        mission:",
    policy,
    ""
  ].join("\n"));
};

const createNestedNetworkProject = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-view-model-"));
  temporaryDirectories.push(directory);
  await writeAgent(path.join(directory, "agents", "lead"), "lead", [
    "          wake: all"
  ].join("\n"));
  await writeAgent(path.join(directory, "teams", "platform", "agents", "lead"), "platform-lead", [
    "          wake: mentions"
  ].join("\n"));
  await writeUtf8File(path.join(directory, "teams", "platform", "Spawnfile"), [
    'spawnfile_version: "0.1"',
    "kind: team",
    "name: platform-core",
    "members:",
    "  - id: liaison",
    "    ref: ./agents/lead",
    "mode: hierarchical",
    "lead: liaison",
    "external: [liaison]",
    "networks:",
    "  - id: shared",
    "    name: Shared Child",
    "    provider: moltnet",
    "    server:",
    "      mode: managed",
    "      listen:",
    "        bind: 127.0.0.1",
    "        port: 8787",
    "      store:",
    "        kind: memory",
    "      auth:",
    "        mode: none",
    "    rooms:",
    "      - id: mission",
    "        members: [liaison]",
    ""
  ].join("\n"));
  await writeUtf8File(path.join(directory, "Spawnfile"), [
    'spawnfile_version: "0.1"',
    "kind: team",
    "name: parent",
    "members:",
    "  - id: lead",
    "    ref: ./agents/lead",
    "  - id: platform",
    "    ref: ./teams/platform",
    "mode: hierarchical",
    "lead: lead",
    "external: [lead]",
    "networks:",
    "  - id: shared",
    "    name: Shared",
    "    provider: moltnet",
    "    server:",
    "      mode: managed",
    "      listen:",
    "        bind: 127.0.0.1",
    "        port: 8787",
    "      store:",
    "        kind: memory",
    "      auth:",
    "        mode: none",
    "      console:",
    "        analytics:",
    "          provider: google",
    "          measurement_id: G-ABC123",
    "      human_ingress: true",
    "    rooms:",
    "      - id: mission",
    "        visibility: public",
    "        write_policy: members",
    "        members: [lead, platform]",
    ""
  ].join("\n"));

  return directory;
};

describe("organization view model", () => {
  it("renders tree metadata, representatives, declarations, and relative paths", async () => {
    const directory = await createNestedNetworkProject();
    const view = await buildOrganizationView(directory);
    const tree = renderOrganizationTree(view, { paths: true });

    expect(view.root).toMatchObject({
      external: ["lead"],
      lead: "lead",
      mode: "hierarchical",
      name: "parent"
    });
    expect(tree).toContain(
      "team parent  mode=hierarchical lead=lead external=lead source=Spawnfile"
    );
    expect(tree).toContain(
      "platform: team platform-core  mode=hierarchical lead=liaison external=liaison source=teams/platform/Spawnfile"
    );
    expect(tree).toContain("lead: agent lead [openclaw] runtime=openclaw source=agents/lead/Spawnfile");
    expect(tree).toContain(
      'network shared "Shared" server=managed auth=none analytics=google human_ingress: mission visibility=public write=members [lead, platform]'
    );
    expect(tree).not.toContain(directory);
  });

  it("groups reused provider network ids and renders network member metadata", async () => {
    const directory = await createNestedNetworkProject();
    const view = await buildOrganizationView(directory);
    const network = view.networks.find((entry) => entry.id === "shared");
    const output = renderOrganizationNetworks(view, {
      ascii: true,
      declared: true,
      paths: true
    });

    expect(view.networks).toHaveLength(1);
    expect(network?.provider).toBe("moltnet");
    expect(network?.declarations?.map((declaration) => declaration.declaringTeamName))
      .toEqual(["parent", "platform-core"]);
    expect(output).toContain("`-- moltnet shared");
    expect(output).toContain(
      'shared "Shared" on parent server=managed auth=none analytics=google human_ingress declared_source=Spawnfile'
    );
    expect(output).toContain("#mission visibility=public write=members");
    expect(output).toContain(
      'shared "Shared Child" on platform-core server=managed auth=none declared_source=teams/platform/Spawnfile'
    );
    expect(output).toContain("declared members: lead, platform");
    expect(output).toContain(
      "lead  team=parent member=lead wake=all source=agents/lead/Spawnfile"
    );
    expect(output).toContain(
      "platform-lead  represents=platform team=platform-core member=liaison source=teams/platform/agents/lead/Spawnfile"
    );
    expect(output).toContain(
      "platform-lead  team=platform-core member=liaison wake=mentions source=teams/platform/agents/lead/Spawnfile"
    );
    expect(output).not.toContain(directory);
  });

  it("builds declared and concrete network views from nested Spawnfiles", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-view-networks-"));
    temporaryDirectories.push(directory);
    await ensureDirectory(path.join(directory, "agents", "lead"));
    await ensureDirectory(path.join(directory, "teams", "child", "agents", "rep"));
    await writeUtf8File(path.join(directory, "agents", "lead", "Spawnfile"), [
      'spawnfile_version: "0.1"',
      "kind: agent",
      "name: lead",
      "runtime: openclaw",
      ""
    ].join("\n"));
    await writeUtf8File(path.join(directory, "teams", "child", "agents", "rep", "Spawnfile"), [
      'spawnfile_version: "0.1"',
      "kind: agent",
      "name: rep",
      "runtime: openclaw",
      "surfaces:",
      "  moltnet:",
      "    - network: org",
      "      rooms:",
      "        shared:",
      "          wake: mentions",
      ""
    ].join("\n"));
    await writeUtf8File(path.join(directory, "teams", "child", "Spawnfile"), [
      'spawnfile_version: "0.1"',
      "kind: team",
      "name: child",
      "members:",
      "  - id: rep",
      "    ref: ./agents/rep",
      "mode: hierarchical",
      "lead: rep",
      "external: [rep]",
      "networks:",
      "  - id: org",
      "    provider: moltnet",
      "    server:",
      "      mode: managed",
      "      listen:",
      "        bind: 127.0.0.1",
      "        port: 8787",
      "      store:",
      "        kind: memory",
      "      auth:",
      "        mode: none",
      "    rooms:",
      "      - id: shared",
      "        members: [rep]",
      ""
    ].join("\n"));
    await writeUtf8File(path.join(directory, "Spawnfile"), [
      'spawnfile_version: "0.1"',
      "kind: team",
      "name: parent",
      "members:",
      "  - id: lead",
      "    ref: ./agents/lead",
      "  - id: child",
      "    ref: ./teams/child",
      "mode: swarm",
      "networks:",
      "  - id: org",
      "    provider: moltnet",
      "    server:",
      "      mode: managed",
      "      listen:",
      "        bind: 127.0.0.1",
      "        port: 8787",
      "      store:",
      "        kind: memory",
      "      auth:",
      "        mode: none",
      "    rooms:",
      "      - id: shared",
      "        members: [lead, child]",
      ""
    ].join("\n"));

    const view = await buildOrganizationView(directory);
    const sharedNetwork = view.networks.find((network) => network.id === "org");
    const parentNetwork = sharedNetwork?.declarations?.find((declaration) =>
      declaration.declaringTeamName === "parent"
    );
    const childNetwork = sharedNetwork?.declarations?.find((declaration) =>
      declaration.declaringTeamName === "child"
    );

    expect(view.networks).toHaveLength(1);
    expect(parentNetwork?.rooms[0]?.declaredMembers).toEqual(["lead", "child"]);
    expect(parentNetwork?.rooms[0]?.members.map((member) => member.concreteMemberId))
      .toEqual(["lead", "rep"]);
    expect(childNetwork?.rooms[0]?.declaredMembers).toEqual(["rep"]);
    expect(childNetwork?.rooms[0]?.members.map((member) => member.concreteMemberId))
      .toEqual(["rep"]);
    expect(renderOrganizationTree(view)).toContain(
      'network org "org" server=managed auth=none: shared [lead, child]'
    );
  });

  it("disambiguates duplicate node names in the view model", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-view-duplicates-"));
    temporaryDirectories.push(directory);
    await ensureDirectory(path.join(directory, "agents", "first"));
    await ensureDirectory(path.join(directory, "agents", "second"));
    for (const agentDirectory of ["first", "second"]) {
      await writeUtf8File(path.join(directory, "agents", agentDirectory, "Spawnfile"), [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: worker",
        "runtime: openclaw",
        ""
      ].join("\n"));
    }
    await writeUtf8File(path.join(directory, "Spawnfile"), [
      'spawnfile_version: "0.1"',
      "kind: team",
      "name: root",
      "members:",
      "  - id: first",
      "    ref: ./agents/first",
      "  - id: second",
      "    ref: ./agents/second",
      "mode: swarm",
      ""
    ].join("\n"));

    const view = await buildOrganizationView(directory);
    const output = renderOrganizationTree(view);

    expect(view.contexts).toEqual([]);
    expect(view.runtimes).toEqual([
      {
        name: "openclaw",
        nodeIds: ["agent:worker", expect.stringMatching(/^agent:worker#[a-f0-9]{8}$/)]
      }
    ]);
    expect(view.diagnostics).toEqual([]);
    expect(view.networks).toEqual([]);
    expect(view.root.networks).toEqual([]);
    expect(output).toContain("worker [agent:worker]");
    expect(output).toMatch(/worker \[agent:worker#[a-f0-9]{8}\]/);
  });

  it("projects declared agent details needed by status", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-view-details-"));
    temporaryDirectories.push(directory);
    await ensureDirectory(path.join(directory, "skills", "moltnet"));
    await writeUtf8File(path.join(directory, "IDENTITY.md"), "identity\n");
    await writeUtf8File(path.join(directory, "AGENTS.md"), "system\n");
    await writeUtf8File(path.join(directory, "skills", "moltnet", "SKILL.md"), [
      "---",
      "name: moltnet",
      "description: Moltnet skill",
      "---",
      "# Moltnet",
      ""
    ].join("\n"));
    await writeUtf8File(path.join(directory, "Spawnfile"), [
      'spawnfile_version: "0.1"',
      "kind: agent",
      "name: analyst",
      "runtime:",
      "  name: openclaw",
      "execution:",
      "  model:",
      "    primary:",
      "      provider: openai",
      "      name: gpt-5",
      "      auth:",
      "        method: api_key",
      "        key: OPENAI_API_KEY",
      "policy:",
      "  mode: warn",
      "  on_degrade: warn",
      "schedule:",
      "  kind: cron",
      "  cron: \"0 9 * * *\"",
      "  timezone: UTC",
      "workspace:",
      "  docs:",
      "    identity: IDENTITY.md",
      "    system: AGENTS.md",
      "  skills:",
      "    - ref: ./skills/moltnet",
      "  resources:",
      "    - id: product",
      "      kind: git",
      "      url: https://example.com/product.git",
      "      mount: ./repos/product",
      "      mode: readonly",
      "environment:",
      "  packages:",
      "    - id: gh",
      "      manager: apt",
      "      name: gh",
      "  mcp_servers:",
      "    - name: search",
      "      transport: stdio",
      "      command: search",
      "surfaces:",
      "  discord:",
      "    access:",
      "      mode: open",
      ""
    ].join("\n"));

    const view = await buildOrganizationView(directory);

    expect(view.runtimes).toEqual([{ name: "openclaw", nodeIds: ["agent:analyst"] }]);
    expect(view.root.declared).toMatchObject({
      docs: [{ role: "identity" }, { role: "system" }],
      mcpServers: [{ name: "search", transport: "stdio" }],
      model: { authMethod: "api_key", name: "gpt-5", provider: "openai" },
      packages: [{ id: "gh", manager: "apt", name: "gh" }],
      policy: { mode: "warn", onDegrade: "warn" },
      resources: [{ id: "product", kind: "git", mode: "readonly", mount: "./repos/product", sharing: "per_agent" }],
      schedule: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
      skills: [{ name: "moltnet", ref: "./skills/moltnet", requiresMcp: [] }],
      surfaces: [{ name: "discord", scopes: ["discord"] }]
    });
  });
});
