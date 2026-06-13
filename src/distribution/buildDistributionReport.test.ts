import { describe, expect, it } from "vitest";

import {
  buildDistributionReport,
  createDistributionImageLabels
} from "./buildDistributionReport.js";
import type { BuildDistributionReportInput } from "./buildDistributionReport.js";
import { createDistributionFingerprint } from "./fingerprint.js";
import {
  DISTRIBUTION_REPORT_IMAGE_PATH,
  DISTRIBUTION_REPORT_VERSION,
  IMAGE_CONTRACT_VERSION
} from "./types.js";

const createInput = (
  overrides: Partial<BuildDistributionReportInput> = {}
): BuildDistributionReportInput => ({
  envVariables: [
    { categories: ["model"], generated: false, name: "OPENAI_API_KEY", required: true },
    { categories: ["project"], generated: false, name: "SEARCH_API_KEY", required: false },
    { categories: ["runtime"], generated: true, name: "OPENCLAW_GATEWAY_TOKEN", required: true },
    { categories: ["surface"], generated: false, name: "SLACK_BOT_TOKEN", required: true }
  ],
  generatedAt: "2026-06-13T00:00:00.000Z",
  internalPorts: [8787, 4444],
  modelAuthMethods: { openai: "api_key" },
  moltnetNetworks: [{ binding: "env", id: "research_floor", server_mode: "managed" }],
  organization: {
    agents: [
      { id: "agent:analyst", name: "Analyst", runtime: "picoclaw", teams: ["team:research-cell"] }
    ],
    project: "research-cell",
    teams: [{ agents: ["agent:analyst"], id: "team:research-cell", name: "research-cell" }]
  },
  persistentMounts: [
    {
      durability: "persistent",
      id: "moltnet-research-floor-store",
      kind: "volume",
      target: "/var/lib/spawnfile/moltnet/networks/research-floor"
    }
  ],
  portMappings: [{ internal_port: 8787, published_port: 18787 }],
  publishedPorts: [18787],
  resources: [],
  runtimeInstances: [
    {
      config_path: "/opt/spawnfile/instances/agent-analyst/config.json",
      home_path: "/opt/spawnfile/instances/agent-analyst/home",
      id: "agent-analyst",
      internal_port: 4444,
      model_auth_methods: { openai: "api_key" },
      model_secrets_required: ["OPENAI_API_KEY"],
      node_ids: ["agent:analyst"],
      published_port: null,
      runtime: "picoclaw",
      workspace_path: "/opt/spawnfile/instances/agent-analyst/workspace"
    }
  ],
  ...overrides
});

describe("buildDistributionReport", () => {
  it("builds the v1 report with categorized required/generated secret entries", () => {
    const report = buildDistributionReport(createInput());

    expect(report.version).toBe(DISTRIBUTION_REPORT_VERSION);
    expect(report.organization.project).toBe("research-cell");
    expect(report.secrets.model).toEqual([
      { generated: false, name: "OPENAI_API_KEY", required: true }
    ]);
    expect(report.secrets.project).toEqual([
      { generated: false, name: "SEARCH_API_KEY", required: false }
    ]);
    expect(report.secrets.runtime).toEqual([
      { generated: true, name: "OPENCLAW_GATEWAY_TOKEN", required: true }
    ]);
    expect(report.secrets.surface).toEqual([
      { generated: false, name: "SLACK_BOT_TOKEN", required: true }
    ]);
    expect(report.internal_ports).toEqual([4444, 8787]);
    expect(report.ports).toEqual([18787]);
    expect(report.moltnet.networks).toEqual([
      { binding: "env", id: "research_floor", server_mode: "managed" }
    ]);
    expect(report.runtime_instances[0]?.node_ids).toEqual(["agent:analyst"]);
    expect(report.runtime_instances[0]?.model_auth_methods).toEqual({ openai: "api_key" });
  });

  it("keeps model_auth_methods as a provider-keyed record, never an array", () => {
    const report = buildDistributionReport(createInput());
    expect(Array.isArray(report.model_auth_methods)).toBe(false);
    expect(report.model_auth_methods.openai).toBe("api_key");
  });

  it("computes a stable fingerprint that ignores generated_at", () => {
    const first = buildDistributionReport(createInput({ generatedAt: "2026-01-01T00:00:00.000Z" }));
    const second = buildDistributionReport(createInput({ generatedAt: "2026-02-02T00:00:00.000Z" }));
    expect(first.compile_fingerprint).toBe(second.compile_fingerprint);
    expect(first.compile_fingerprint).toMatch(/^sf1:[0-9a-f]{12}$/);
  });

  it("changes the fingerprint when report content changes", () => {
    const base = buildDistributionReport(createInput());
    const changed = buildDistributionReport(
      createInput({ publishedPorts: [9999], portMappings: [] })
    );
    expect(base.compile_fingerprint).not.toBe(changed.compile_fingerprint);
  });

  it("matches the standalone fingerprint helper over the report body", () => {
    const report = buildDistributionReport(createInput());
    const { compile_fingerprint, generated_at, ...body } = report;
    void generated_at;
    expect(createDistributionFingerprint(body)).toBe(compile_fingerprint);
  });

  it("does not carry creator volume names in persistent mounts", () => {
    const report = buildDistributionReport(createInput());
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("volume_name");
    expect(report.persistent_mounts[0]).toEqual({
      durability: "persistent",
      id: "moltnet-research-floor-store",
      kind: "volume",
      target: "/var/lib/spawnfile/moltnet/networks/research-floor"
    });
  });
});

describe("createDistributionImageLabels", () => {
  it("emits the four contract labels", () => {
    const labels = createDistributionImageLabels("research-cell", "sf1:abc123def456");
    expect(labels).toEqual({
      "com.spawnfile.compile_fingerprint": "sf1:abc123def456",
      "com.spawnfile.image_contract": IMAGE_CONTRACT_VERSION,
      "com.spawnfile.project": "research-cell",
      "com.spawnfile.report": DISTRIBUTION_REPORT_IMAGE_PATH
    });
  });
});
