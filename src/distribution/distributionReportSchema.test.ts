import { describe, expect, it } from "vitest";

import {
  buildDistributionReport,
  type BuildDistributionReportInput
} from "./buildDistributionReport.js";
import { parseDistributionReport } from "./distributionReportSchema.js";

const validReport = (worldBindings?: BuildDistributionReportInput["worldBindings"]) =>
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
    runtimeInstances: [],
    ...(worldBindings ? { worldBindings } : {})
  });

describe("parseDistributionReport", () => {
  it("accepts a freshly built report", () => {
    const report = validReport();
    expect(parseDistributionReport(report)).toEqual(report);
  });

  it("accepts binding evidence and fingerprints its canonical artifact digest", () => {
    const evidence = {
      artifact_path: "/spawnfile/world-bindings.json" as const,
      digest: `sha256:${"a".repeat(64)}`,
      schema: "simfile.world-bindings.v1" as const
    };
    const report = validReport(evidence);
    expect(parseDistributionReport(report).world_bindings).toEqual(evidence);
    expect(report.compile_fingerprint).not.toBe(validReport().compile_fingerprint);
    report.world_bindings = { ...evidence, digest: "not-a-digest" };
    expect(() => parseDistributionReport(report)).toThrow(/Invalid distribution report/u);
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

  it("accepts only the declared exclusive reattach lifecycle", () => {
    const report = validReport();
    report.persistent_mounts = [{
      durability: "persistent", id: "realm", kind: "volume",
      lifecycle: "exclusive-reattach", target: "/var/lib/example/realm"
    }];
    expect(parseDistributionReport(report).persistent_mounts[0]?.lifecycle).toBe("exclusive-reattach");
    (report.persistent_mounts[0] as { lifecycle?: string }).lifecycle = "clone";
    expect(() => parseDistributionReport(report)).toThrow(/Invalid distribution report/u);
  });

  it("accepts a declared volume name and rejects one that is not a docker volume name", () => {
    // It is used verbatim as a `docker run --mount source=`, so a value with
    // ':' or '..' would inject mount fields or traverse.
    const report = validReport();
    report.persistent_mounts = [{
      declared_volume_name: "clank-newsroom-store", durability: "persistent",
      id: "moltnet-newsroom-store", kind: "volume",
      lifecycle: "exclusive-reattach", target: "/var/lib/example/store"
    }];
    expect(parseDistributionReport(report).persistent_mounts[0]?.declared_volume_name)
      .toBe("clank-newsroom-store");
    for (const hostile of ["../escape", "vol:ro,z", "/absolute", "with space", ""]) {
      (report.persistent_mounts[0] as { declared_volume_name?: string }).declared_volume_name = hostile;
      expect(() => parseDistributionReport(report)).toThrow(/Invalid distribution report/u);
    }
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

  it("accepts current engine disclosures and workspace resource kinds", () => {
    const report = validReport();
    report.runtime_instances = [{
      config_path: "/var/lib/spawnfile/daimon/config.json",
      engine_by_node_id: { "agent:reviewer": "grok", "agent:writer": "codex" },
      home_path: "/var/lib/spawnfile/daimon/home",
      id: "daimon-organization",
      internal_port: null,
      model_auth_methods: {},
      model_secrets_required: [],
      node_ids: ["agent:reviewer", "agent:writer"],
      published_port: null,
      runtime: "daimon",
      workspace_path: "/var/lib/spawnfile/daimon/workspace"
    }];
    report.resources = [{
      id: "workspace-seed", kind: "bundle", link_path: "/workspace/seed",
      mode: "readonly", mount: "./seed", sharing: "per_agent"
    }];
    expect(parseDistributionReport(report)).toEqual(report);
  });

  it("rejects unknown engine and resource variants", () => {
    const report = validReport();
    report.runtime_instances = [{
      config_path: "/config", engine_by_node_id: { "agent:x": "unknown-engine" as never },
      home_path: "/home", id: "daimon-organization", internal_port: null,
      model_auth_methods: {}, model_secrets_required: [], node_ids: ["agent:x"],
      published_port: null, runtime: "daimon", workspace_path: "/workspace"
    }];
    expect(() => parseDistributionReport(report)).toThrow(/Invalid distribution report/u);
    delete report.runtime_instances[0]!.engine_by_node_id;
    report.resources = [{ id: "x", kind: "device" as never, link_path: "/x", mode: "readonly", mount: "./x", sharing: "per_agent" }];
    expect(() => parseDistributionReport(report)).toThrow(/Invalid distribution report/u);
  });
});
