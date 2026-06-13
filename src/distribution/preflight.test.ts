import { describe, expect, it } from "vitest";

import { runImagePreflight } from "./preflight.js";
import type { DistributionReport } from "./types.js";

const createReport = (overrides: Partial<DistributionReport> = {}): DistributionReport => ({
  compile_fingerprint: "sf1:abc123def456",
  generated_at: "2026-06-13T00:00:00.000Z",
  internal_ports: [],
  model_auth_methods: { anthropic: "api_key" },
  moltnet: { networks: [] },
  organization: { agents: [], project: "research-cell", teams: [] },
  persistent_mounts: [],
  port_mappings: [],
  ports: [],
  resources: [],
  runtime_instances: [
    {
      config_path: "/c",
      home_path: null,
      id: "agent-analyst",
      internal_port: null,
      model_auth_methods: { anthropic: "api_key" },
      model_secrets_required: ["ANTHROPIC_API_KEY"],
      node_ids: ["agent:analyst"],
      published_port: null,
      runtime: "picoclaw",
      workspace_path: "/w"
    }
  ],
  secrets: {
    model: [{ generated: false, name: "ANTHROPIC_API_KEY", required: true }],
    project: [
      { generated: false, name: "DIST_REQUIRED_TOKEN", required: true },
      { generated: false, name: "DIST_OPTIONAL_TOKEN", required: false }
    ],
    runtime: [{ generated: true, name: "OPENCLAW_GATEWAY_TOKEN", required: true }],
    surface: []
  },
  version: "spawnfile.distribution-report.v1",
  ...overrides
});

describe("runImagePreflight", () => {
  it("passes when all required non-generated secrets are present", () => {
    const result = runImagePreflight({
      authValues: { ANTHROPIC_API_KEY: "sk-a", DIST_REQUIRED_TOKEN: "tok" },
      report: createReport()
    });
    expect(result.requiredSecrets).toEqual(["ANTHROPIC_API_KEY", "DIST_REQUIRED_TOKEN"]);
    expect(result.generatedSecrets).toEqual(["OPENCLAW_GATEWAY_TOKEN"]);
  });

  it("fails listing missing required secrets, ignoring optional and generated", () => {
    expect(() =>
      runImagePreflight({
        authValues: { ANTHROPIC_API_KEY: "sk-a" },
        report: createReport()
      })
    ).toThrow(/DIST_REQUIRED_TOKEN/);
  });

  it("does not demand generated runtime secrets", () => {
    const result = runImagePreflight({
      authValues: { ANTHROPIC_API_KEY: "sk-a", DIST_REQUIRED_TOKEN: "tok" },
      report: createReport()
    });
    expect(result.requiredSecrets).not.toContain("OPENCLAW_GATEWAY_TOKEN");
  });

  it("does not demand optional secrets", () => {
    expect(() =>
      runImagePreflight({
        authValues: { ANTHROPIC_API_KEY: "sk-a", DIST_REQUIRED_TOKEN: "tok" },
        report: createReport()
      })
    ).not.toThrow();
  });

  it("rejects unsupported import-based auth before deployment", () => {
    const report = createReport({
      runtime_instances: [
        {
          config_path: "/c",
          home_path: null,
          id: "agent-coordinator",
          internal_port: null,
          model_auth_methods: { anthropic: "claude-code" },
          model_secrets_required: [],
          node_ids: ["agent:coordinator"],
          published_port: null,
          runtime: "openclaw",
          workspace_path: "/w"
        }
      ]
    });
    expect(() => runImagePreflight({ authValues: {}, report })).toThrow(
      /only api_key model auth.*openclaw\/agent-coordinator \(anthropic: claude-code\)/
    );
  });
});
