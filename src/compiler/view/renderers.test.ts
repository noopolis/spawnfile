import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { ensureDirectory, removeDirectory, writeUtf8File } from "../../filesystem/index.js";
import { buildOrganizationView } from "./buildOrganizationView.js";
import { renderOrganizationNetworks } from "./renderNetworks.js";
import { renderOrganizationTree } from "./renderTree.js";
import type { OrganizationView } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

const createView = (): OrganizationView => ({
  contexts: [],
  diagnostics: [],
  inputPath: "/tmp/root",
  networks: [
    {
      declaringTeamName: "parent",
      declaringTeamSource: "/tmp/parent/Spawnfile",
      expose: true,
      id: "org",
      name: "Org",
      provider: "moltnet",
      rooms: [
        {
          declaredMembers: ["coordinator", "child"],
          id: "general",
          members: [
            {
              agentName: "coordinator-agent",
              agentSource: "/tmp/coordinator/Spawnfile",
              concreteMemberId: "coordinator",
              declaredSlot: "coordinator",
              directTeamName: "parent",
              directTeamSource: "/tmp/parent/Spawnfile",
              policy: { read: "all", reply: "auto" }
            },
            {
              agentName: "rep-agent",
              agentSource: "/tmp/rep/Spawnfile",
              concreteMemberId: "rep",
              declaredSlot: "child",
              directTeamName: "child",
              directTeamSource: "/tmp/child/Spawnfile",
              representedSlot: "child",
              representedTeamName: "child",
              representedTeamSource: "/tmp/child/Spawnfile",
              representativePath: ["child", "rep"]
            }
          ]
        }
      ]
    }
  ],
  root: {
    children: [
      {
        label: "coordinator",
        node: {
          children: [],
          displayName: "coordinator-agent",
          id: "agent:coordinator-agent",
          kind: "agent",
          name: "coordinator-agent",
          networks: [],
          runtimeName: "openclaw",
          source: "/tmp/coordinator/Spawnfile"
        },
        relation: "team_member"
      },
      {
        label: "child",
        node: {
          children: [
            {
              label: "rep",
              node: {
                children: [],
                displayName: "rep-agent",
                id: "agent:rep-agent",
                kind: "agent",
                name: "rep-agent",
                networks: [],
                runtimeName: "openclaw",
                source: "/tmp/rep/Spawnfile"
              },
              relation: "team_member"
            }
          ],
          displayName: "child",
          id: "team:child",
          kind: "team",
          name: "child",
          networks: [],
          runtimeName: null,
          source: "/tmp/child/Spawnfile"
        },
        relation: "team_member"
      }
    ],
    displayName: "parent",
    id: "team:parent",
    kind: "team",
    name: "parent",
    networks: [
      {
        expose: true,
        id: "org",
        name: "Org",
        provider: "moltnet",
        rooms: [
          {
            declaredMembers: ["coordinator", "child"],
            id: "general"
          }
        ]
      }
    ],
    runtimeName: null,
    source: "/tmp/parent/Spawnfile"
  },
  runtimes: []
});

describe("compiler view renderers", () => {
  it("renders unicode and ascii organization trees", () => {
    const view = createView();

    expect(renderOrganizationTree(view)).toContain("├── coordinator: agent coordinator-agent");
    expect(renderOrganizationTree(view)).toContain('network org "Org" human_ingress: general [coordinator, child]');
    expect(renderOrganizationTree(view)).toContain("└── child: team child");
    expect(renderOrganizationTree(view, { ascii: true })).toContain("|-- coordinator: agent coordinator-agent");
  });

  it("renders tree paths when requested", () => {
    const output = renderOrganizationTree(createView(), { paths: true });

    expect(output).toContain("team parent </tmp/parent/Spawnfile>");
    expect(output).toContain("agent rep-agent [openclaw] runtime=openclaw </tmp/rep/Spawnfile>");
  });

  it("renders colored tree network summaries", () => {
    const output = renderOrganizationTree(createView(), { color: true });

    expect(output).toContain('\u001b[36morg\u001b[0m "Org" human_ingress');
  });

  it("renders declared network slots and paths when requested", () => {
    const output = renderOrganizationNetworks(createView(), {
      declared: true,
      paths: true
    });

    expect(output).toContain("org \"Org\" on parent human_ingress </tmp/parent/Spawnfile>");
    expect(output).toContain("declared members: coordinator, child");
    expect(output).toContain("rep-agent  represents=child member=rep </tmp/rep/Spawnfile>");
  });

  it("renders ascii colored networks with empty rooms and empty policy markers", () => {
    const view = createView();
    view.networks = [
      {
        declaringTeamName: "parent",
        declaringTeamSource: "/tmp/parent/Spawnfile",
        expose: false,
        id: "org",
        name: "Org",
        provider: "moltnet",
        rooms: [
          {
            declaredMembers: [],
            id: "empty",
            members: []
          },
          {
            declaredMembers: ["observer"],
            id: "solo",
            members: [
              {
                agentName: "observer-agent",
                agentSource: "/tmp/observer/Spawnfile",
                concreteMemberId: "observer",
                declaredSlot: "observer",
                directTeamName: "parent",
                directTeamSource: "/tmp/parent/Spawnfile",
                policy: {}
              }
            ]
          }
        ]
      },
      {
        declaringTeamName: "child",
        declaringTeamSource: "/tmp/child/Spawnfile",
        expose: false,
        id: "child_net",
        name: "Child Net",
        provider: "moltnet",
        rooms: []
      }
    ];

    const output = renderOrganizationNetworks(view, { ascii: true, color: true });

    expect(output).toContain('|-- moltnet \u001b[36morg\u001b[0m');
    expect(output).toContain('`-- org "Org" on parent');
    expect(output).toContain("`-- observer-agent  team=parent member=observer");
    expect(output).toContain('`-- moltnet \u001b[36mchild_net\u001b[0m');
    expect(output).toContain('`-- child_net "Child Net" on child');
    expect(output).not.toContain("declared members:");
    expect(output).not.toContain("exposed");
  });

  it("renders a no-networks message", () => {
    const view = createView();
    view.networks = [];

    expect(renderOrganizationNetworks(view)).toBe("No Moltnet networks.");
  });

  it("omits synthesized representative policy in network output", () => {
    const output = renderOrganizationNetworks(createView(), { declared: true });
    const coordinatorLine = output.split("\n").find((line) => line.includes("coordinator-agent"));
    const representativeLine = output.split("\n").find((line) => line.includes("rep-agent"));

    expect(coordinatorLine).toContain("read=all reply=auto");
    expect(representativeLine).not.toContain("read=");
    expect(representativeLine).not.toContain("reply=");
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
      "          read: mentions",
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
    expect(view.runtimes).toEqual([]);
    expect(view.diagnostics).toEqual([]);
    expect(view.networks).toEqual([]);
    expect(view.root.networks).toEqual([]);
    expect(output).toContain("worker [agent:worker]");
    expect(output).toMatch(/worker \[agent:worker#[a-f0-9]{8}\]/);
  });
});
