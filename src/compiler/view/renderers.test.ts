import { describe, expect, it } from "vitest";

import { renderOrganizationNetworks } from "./renderNetworks.js";
import { renderOrganizationTree } from "./renderTree.js";
import type { OrganizationView } from "./types.js";

const createView = (): OrganizationView => ({
  contexts: [],
  diagnostics: [],
  inputPath: "/tmp/root",
  networks: [
    {
      agentRegistration: "open",
      declaringTeamName: "parent",
      declaringTeamSource: "/tmp/parent/Spawnfile",
      consoleAnalytics: "google",
      debugEvents: true,
      expose: true,
      id: "org",
      name: "Org",
      provider: "moltnet",
      publicRead: true,
      rooms: [
        {
          declaredMembers: ["coordinator", "child"],
          id: "general",
          visibility: "public",
          writePolicy: "members",
          members: [
            {
              agentName: "coordinator-agent",
              agentSource: "/tmp/coordinator/Spawnfile",
              concreteMemberId: "coordinator",
              declaredSlot: "coordinator",
              directTeamName: "parent",
              directTeamSource: "/tmp/parent/Spawnfile",
              policy: { wake: "all" }
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
        agentRegistration: "open",
        expose: true,
        consoleAnalytics: "google",
        debugEvents: true,
        id: "org",
        name: "Org",
        provider: "moltnet",
        publicRead: true,
        rooms: [
          {
            declaredMembers: ["coordinator", "child"],
            id: "general",
            visibility: "public",
            writePolicy: "members"
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
    expect(renderOrganizationTree(view)).toContain('network org "Org" public_read=true registration=open analytics=google debug_events human_ingress: general visibility=public write=members [coordinator, child]');
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

    expect(output).toContain('\u001b[36morg\u001b[0m "Org" public_read=true registration=open analytics=google debug_events human_ingress');
    expect(output).toContain("general visibility=public write=members");
  });

  it("renders subject-keyed tree annotations", () => {
    const output = renderOrganizationTree(createView(), {
      annotationFor: (subject) => subject === "agent:coordinator-agent" ? ["compiled=warn"] : []
    });

    expect(output).toContain("coordinator: agent coordinator-agent [openclaw] runtime=openclaw  compiled=warn");
    expect(output).not.toContain("rep-agent [openclaw] runtime=openclaw  compiled=warn");
  });

  it("renders declared network slots and paths when requested", () => {
    const output = renderOrganizationNetworks(createView(), {
      declared: true,
      paths: true
    });

    expect(output).toContain("org \"Org\" on parent public_read=true registration=open analytics=google debug_events human_ingress </tmp/parent/Spawnfile>");
    expect(output).toContain("#general visibility=public write=members");
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

  it("renders explicit public_read false separately from omitted public_read", () => {
    const view = createView();
    const [network] = view.networks;
    if (network) {
      network.publicRead = false;
    }
    const [treeNetwork] = view.root.networks ?? [];
    if (treeNetwork) {
      treeNetwork.publicRead = false;
    }

    expect(renderOrganizationTree(view)).toContain("public_read=false");
    expect(renderOrganizationNetworks(view)).toContain("public_read=false");
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

    expect(coordinatorLine).toContain("wake=all");
    expect(representativeLine).not.toContain("wake=");
  });

});
