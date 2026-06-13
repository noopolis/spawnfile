import { describe, expect, it } from "vitest";

import { buildDistributionReport } from "./buildDistributionReport.js";
import { projectImageOrganizationView } from "./projectImageView.js";

const teamReport = () =>
  buildDistributionReport({
    envVariables: [],
    generatedAt: "2026-06-13T00:00:00.000Z",
    internalPorts: [],
    modelAuthMethods: {},
    moltnetNetworks: [{ binding: "env", id: "dist_lab", server_mode: "managed" }],
    organization: {
      agents: [
        { id: "agent:coordinator", name: "coordinator", runtime: "openclaw", teams: ["team:org"] },
        { id: "agent:researcher", name: "researcher", runtime: "picoclaw", teams: ["team:org"] }
      ],
      project: "distribution-org",
      teams: [
        { agents: ["agent:coordinator", "agent:researcher"], id: "team:org", name: "distribution-org" }
      ]
    },
    persistentMounts: [],
    portMappings: [],
    publishedPorts: [],
    resources: [],
    runtimeInstances: [
      {
        config_path: "/c",
        home_path: null,
        id: "openclaw-coordinator",
        internal_port: null,
        model_auth_methods: {},
        model_secrets_required: [],
        node_ids: ["agent:coordinator"],
        published_port: null,
        runtime: "openclaw",
        workspace_path: "/w"
      }
    ]
  });

describe("projectImageOrganizationView", () => {
  it("projects a team root with member agent edges", () => {
    const view = projectImageOrganizationView(teamReport(), "you/org:1.0.0");
    expect(view.root.kind).toBe("team");
    expect(view.root.id).toBe("team:org");
    expect(view.root.children.map((edge) => edge.node.id)).toEqual([
      "agent:coordinator",
      "agent:researcher"
    ]);
    expect(view.root.source).toBe("<image>");
  });

  it("projects networks and runtimes from the report", () => {
    const view = projectImageOrganizationView(teamReport(), "you/org:1.0.0");
    expect(view.networks.map((network) => network.id)).toEqual(["dist_lab"]);
    expect(view.runtimes.map((runtime) => runtime.name)).toEqual(["openclaw"]);
  });

  it("projects a single agent as the root when there are no teams", () => {
    const report = buildDistributionReport({
      envVariables: [],
      generatedAt: "2026-06-13T00:00:00.000Z",
      internalPorts: [],
      modelAuthMethods: {},
      moltnetNetworks: [],
      organization: {
        agents: [{ id: "agent:solo", name: "solo", runtime: "picoclaw", teams: [] }],
        project: "solo",
        teams: []
      },
      persistentMounts: [],
      portMappings: [],
      publishedPorts: [],
      resources: [],
      runtimeInstances: []
    });
    const view = projectImageOrganizationView(report, "you/solo:1.0.0");
    expect(view.root.kind).toBe("agent");
    expect(view.root.id).toBe("agent:solo");
  });
});
