import { describe, expect, it } from "vitest";

import { buildDistributionReport } from "./buildDistributionReport.js";
import {
  buildImageInterfaceSummary,
  renderImageInterface
} from "./renderImageInterface.js";

const report = () =>
  buildDistributionReport({
    envVariables: [
      { categories: ["model"], generated: false, name: "ANTHROPIC_API_KEY", required: true },
      { categories: ["project"], generated: false, name: "OPTIONAL_TOKEN", required: false },
      { categories: ["runtime"], generated: true, name: "OPENCLAW_GATEWAY_TOKEN", required: true }
    ],
    generatedAt: "2026-06-13T00:00:00.000Z",
    internalPorts: [],
    modelAuthMethods: { anthropic: "api_key" },
    moltnetNetworks: [{ binding: "env", id: "dist_lab", server_mode: "managed" }],
    organization: {
      agents: [
        { id: "agent:coordinator", name: "coordinator", runtime: "openclaw", teams: ["team:org"] }
      ],
      project: "distribution-org",
      teams: [{ agents: ["agent:coordinator"], id: "team:org", name: "distribution-org" }]
    },
    persistentMounts: [],
    portMappings: [],
    publishedPorts: [8080],
    resources: [],
    runtimeInstances: []
  });

describe("buildImageInterfaceSummary", () => {
  it("lists only required non-generated secrets", () => {
    const summary = buildImageInterfaceSummary(report(), "you/org:1.0.0");
    expect(summary.requiredSecrets).toEqual(["ANTHROPIC_API_KEY"]);
    expect(summary.requiredSecrets).not.toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(summary.requiredSecrets).not.toContain("OPTIONAL_TOKEN");
  });

  it("summarizes agents, teams, networks, and ports", () => {
    const summary = buildImageInterfaceSummary(report(), "you/org:1.0.0");
    expect(summary.agents).toEqual([
      { id: "agent:coordinator", name: "coordinator", runtime: "openclaw", teams: ["team:org"] }
    ]);
    expect(summary.networks).toEqual([{ id: "dist_lab", serverMode: "managed" }]);
    expect(summary.ports).toEqual([8080]);
  });
});

describe("renderImageInterface", () => {
  it("renders a human interface view", () => {
    const text = renderImageInterface(report(), { imageRef: "you/org:1.0.0" });
    expect(text).toContain("Image: you/org:1.0.0");
    expect(text).toContain("Declared status is unavailable");
    expect(text).toContain("agent:coordinator  openclaw");
    expect(text).toContain("ANTHROPIC_API_KEY");
    expect(text).toContain("Published ports: 8080");
  });

  it("renders machine JSON when requested", () => {
    const json = renderImageInterface(report(), { imageRef: "you/org:1.0.0", json: true });
    const parsed = JSON.parse(json);
    expect(parsed.project).toBe("distribution-org");
    expect(parsed.requiredSecrets).toEqual(["ANTHROPIC_API_KEY"]);
  });
});
