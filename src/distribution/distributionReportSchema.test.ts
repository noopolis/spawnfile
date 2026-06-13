import { describe, expect, it } from "vitest";

import { buildDistributionReport } from "./buildDistributionReport.js";
import { parseDistributionReport } from "./distributionReportSchema.js";

const validReport = () =>
  buildDistributionReport({
    envVariables: [
      { categories: ["model"], generated: false, name: "OPENAI_API_KEY", required: true }
    ],
    generatedAt: "2026-06-13T00:00:00.000Z",
    internalPorts: [],
    modelAuthMethods: { openai: "api_key" },
    moltnetNetworks: [],
    organization: { agents: [], project: "research-cell", teams: [] },
    persistentMounts: [],
    portMappings: [],
    publishedPorts: [],
    resources: [],
    runtimeInstances: []
  });

describe("parseDistributionReport", () => {
  it("accepts a freshly built report", () => {
    const report = validReport();
    expect(parseDistributionReport(report)).toEqual(report);
  });

  it("rejects a wrong schema version", () => {
    const report = { ...validReport(), version: "spawnfile.distribution-report.v2" };
    expect(() => parseDistributionReport(report)).toThrow(/Invalid distribution report/);
  });

  it("rejects a report with unexpected extra keys", () => {
    const report = { ...validReport(), surprise: true };
    expect(() => parseDistributionReport(report)).toThrow(/Invalid distribution report/);
  });

  it("rejects a report missing required sections", () => {
    const report = validReport() as unknown as Record<string, unknown>;
    delete report.secrets;
    expect(() => parseDistributionReport(report)).toThrow(/Invalid distribution report/);
  });

  it("rejects malformed secret entries", () => {
    const report = validReport();
    (report.secrets.model as unknown) = [{ name: "X" }];
    expect(() => parseDistributionReport(report)).toThrow(/Invalid distribution report/);
  });

  it("rejects a mount target with a colon (mount-spec injection)", () => {
    const report = validReport();
    report.persistent_mounts = [
      { durability: "persistent", id: "store", kind: "volume", target: "/data:ro,z" }
    ];
    expect(() => parseDistributionReport(report)).toThrow(/Invalid distribution report/);
  });

  it("rejects a runtime home_path containing '..'", () => {
    const report = validReport();
    report.runtime_instances = [
      {
        config_path: "/var/lib/spawnfile/x/openclaw.json",
        home_path: "/var/lib/../../etc",
        id: "agent-x",
        internal_port: null,
        model_auth_methods: { anthropic: "api_key" },
        model_secrets_required: [],
        node_ids: ["agent:x"],
        published_port: null,
        runtime: "openclaw",
        workspace_path: "/w"
      }
    ];
    expect(() => parseDistributionReport(report)).toThrow(/Invalid distribution report/);
  });

  it("rejects an out-of-range published port", () => {
    const report = validReport();
    report.ports = [70000];
    expect(() => parseDistributionReport(report)).toThrow(/Invalid distribution report/);
  });

  it("rejects a runtime instance id that would traverse a host path", () => {
    const report = validReport();
    report.runtime_instances = [
      {
        config_path: "/var/lib/spawnfile/x/openclaw.json",
        home_path: "/var/lib/spawnfile/x/home",
        id: "../../../../etc/cron.d/x",
        internal_port: null,
        model_auth_methods: { anthropic: "claude-code" },
        model_secrets_required: [],
        node_ids: ["agent:x"],
        published_port: null,
        runtime: "openclaw",
        workspace_path: "/w"
      }
    ];
    expect(() => parseDistributionReport(report)).toThrow(/Invalid distribution report/);
  });

  it("accepts a compile-generated runtime instance id", () => {
    const report = validReport();
    report.runtime_instances = [
      {
        config_path: "/var/lib/spawnfile/x/openclaw.json",
        home_path: "/var/lib/spawnfile/x/home",
        id: "agent-orchestrator-moltnet-tokens",
        internal_port: 8080,
        model_auth_methods: { anthropic: "api_key" },
        model_secrets_required: [],
        node_ids: ["agent:orchestrator"],
        published_port: 8080,
        runtime: "openclaw",
        workspace_path: "/w"
      }
    ];
    expect(() => parseDistributionReport(report)).not.toThrow();
  });
});
