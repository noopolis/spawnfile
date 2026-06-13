import { describe, expect, it } from "vitest";

import { buildDistributionReport } from "../distribution/index.js";

import { distributionReportToStatusReport, loadedImageCompileReport } from "./imageStatusReport.js";

const report = () =>
  buildDistributionReport({
    envVariables: [
      { categories: ["model"], generated: false, name: "ANTHROPIC_API_KEY", required: true },
      { categories: ["runtime"], generated: true, name: "OPENCLAW_GATEWAY_TOKEN", required: true }
    ],
    generatedAt: "2026-06-13T00:00:00.000Z",
    internalPorts: [4444],
    modelAuthMethods: { anthropic: "api_key" },
    moltnetNetworks: [{ binding: "env", id: "dist_lab", server_mode: "managed" }],
    organization: {
      agents: [{ id: "agent:a", name: "a", runtime: "picoclaw", teams: ["team:o"] }],
      project: "o",
      teams: [{ agents: ["agent:a"], id: "team:o", name: "o" }]
    },
    persistentMounts: [
      { durability: "persistent", id: "store", kind: "volume", target: "/var/lib/spawnfile/x" }
    ],
    portMappings: [{ internal_port: 4444, published_port: 14444 }],
    publishedPorts: [14444],
    resources: [],
    runtimeInstances: [
      {
        config_path: "/c",
        home_path: "/h",
        id: "picoclaw-a",
        internal_port: 4444,
        model_auth_methods: { anthropic: "api_key" },
        model_secrets_required: ["ANTHROPIC_API_KEY"],
        node_ids: ["agent:a"],
        published_port: null,
        runtime: "picoclaw",
        workspace_path: "/w"
      }
    ]
  });

describe("distributionReportToStatusReport", () => {
  it("maps runtime instances, nodes, ports, and mounts", () => {
    const status = distributionReportToStatusReport(report(), "/home/report.json");
    expect(status.compileFingerprint).toMatch(/^sf1:/);
    expect(status.runtimeInstances[0]).toMatchObject({
      configPath: "/c",
      id: "picoclaw-a",
      nodeIds: ["agent:a"],
      runtime: "picoclaw"
    });
    expect(status.nodes.map((node) => node.id).sort()).toEqual(["agent:a", "team:o"]);
    expect(status.portMappings).toEqual([{ internalPort: 4444, publishedPort: 14444 }]);
    expect(status.persistentMounts?.[0]?.mountPath).toBe("/var/lib/spawnfile/x");
  });

  it("includes only required non-generated secrets", () => {
    const status = distributionReportToStatusReport(report(), "/home/report.json");
    expect(status.secretsRequired).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("wraps into a loaded compile report", () => {
    const loaded = loadedImageCompileReport(report(), "/home/report.json");
    expect(loaded.kind).toBe("loaded");
    if (loaded.kind === "loaded") {
      expect(loaded.report.reportPath).toBe("/home/report.json");
    }
  });
});
