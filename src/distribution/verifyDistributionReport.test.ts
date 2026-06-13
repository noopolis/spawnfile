import { describe, expect, it } from "vitest";

import { buildDistributionReport } from "./buildDistributionReport.js";
import { verifyDistributionReport } from "./verifyDistributionReport.js";

const report = () =>
  buildDistributionReport({
    envVariables: [
      { categories: ["model"], generated: false, name: "ANTHROPIC_API_KEY", required: true }
    ],
    generatedAt: "2026-06-13T00:00:00.000Z",
    internalPorts: [],
    modelAuthMethods: { anthropic: "api_key" },
    moltnetNetworks: [],
    organization: { agents: [], project: "research-cell", teams: [] },
    persistentMounts: [],
    portMappings: [],
    publishedPorts: [],
    resources: [],
    runtimeInstances: []
  });

describe("verifyDistributionReport", () => {
  it("accepts a clean report", () => {
    expect(() => verifyDistributionReport({ report: report() })).not.toThrow();
  });

  it("refuses a report carrying a forbidden path fragment", () => {
    const leaky = { ...report(), organization: { ...report().organization, project: "/Users/me/p" } };
    expect(() =>
      verifyDistributionReport({
        forbiddenPathFragments: ["/Users/me/p"],
        report: leaky
      })
    ).toThrow(/leaks a creator path fragment|absolute home path/);
  });

  it("refuses a report with an absolute home path anywhere", () => {
    const leaky = JSON.parse(JSON.stringify(report()));
    leaky.runtime_instances.push({
      config_path: "/Users/creator/.spawn/config.json",
      home_path: null,
      id: "x",
      internal_port: null,
      model_auth_methods: {},
      model_secrets_required: [],
      node_ids: [],
      published_port: null,
      runtime: "picoclaw",
      workspace_path: "/w"
    });
    expect(() => verifyDistributionReport({ report: leaky })).toThrow(/absolute home path/);
  });

  it("refuses a malformed report", () => {
    expect(() => verifyDistributionReport({ report: { version: "wrong" } })).toThrow(
      /Invalid distribution report/
    );
  });
});
