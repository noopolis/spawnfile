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
    "          read: all",
    "          reply: auto"
  ].join("\n"));
  await writeAgent(path.join(directory, "teams", "platform", "agents", "lead"), "platform-lead", [
    "          read: mentions"
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
      "lead  team=parent member=lead read=all reply=auto source=agents/lead/Spawnfile"
    );
    expect(output).toContain(
      "platform-lead  represents=platform team=platform-core member=liaison source=teams/platform/agents/lead/Spawnfile"
    );
    expect(output).toContain(
      "platform-lead  team=platform-core member=liaison read=mentions source=teams/platform/agents/lead/Spawnfile"
    );
    expect(output).not.toContain(directory);
  });
});
