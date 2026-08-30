import { describe, expect, it } from "vitest";

import type { CompileReport, ContainerReport } from "../report/index.js";

import { planArtifactExports } from "./artifactsExportPlan.js";

const baseContainer = (overrides: Partial<ContainerReport> = {}): ContainerReport => ({
  dockerfile: "container/Dockerfile",
  entrypoint: "container/entrypoint",
  env_example: "container/.env.example",
  model_secrets_required: [],
  ports: [],
  runtime_homes: [],
  runtime_instances: [],
  runtime_secrets_required: [],
  runtimes_installed: [],
  secrets_required: [],
  ...overrides
});

const baseReport = (container: ContainerReport): CompileReport => ({
  container,
  diagnostics: [],
  nodes: [],
  root: "/project",
  spawnfile_version: "0.1"
});

describe("planArtifactExports", () => {
  it("plans a single managed moltnet network at flat causal and transcript paths", () => {
    const report = baseReport(baseContainer({
      moltnet: {
        node_plans: [],
        server_plans: [
          {
            base_url: "http://127.0.0.1:8787",
            id: "root-office_lab",
            mode: "managed",
            network_id: "office_lab",
            rooms: []
          }
        ]
      },
      persistent_mounts: [
        {
          id: "moltnet-office_lab-causal",
          mount_path: "/var/lib/spawnfile/moltnet/servers/root-office_lab/causal",
          reason: "managed Moltnet causal event log for office_lab",
          volume_name: "spawnfile-project-moltnet-office_lab-causal-abc123"
        }
      ]
    }));

    const planned = planArtifactExports(report);
    expect(planned).toEqual([
      {
        optional: true,
        relativePath: "raw/moltnet/causal.jsonl",
        source: {
          kind: "volume",
          volumeName: "spawnfile-project-moltnet-office_lab-causal-abc123",
          volumePath: "causal.jsonl"
        }
      },
      {
        optional: true,
        relativePath: "raw/moltnet/transcript.json",
        source: {
          kind: "volume",
          volumeName: "spawnfile-project-moltnet-office_lab-causal-abc123",
          volumePath: "transcript.json"
        }
      }
    ]);
  });

  it("disambiguates causal and transcript by network id when more than one managed network has a mount", () => {
    const report = baseReport(baseContainer({
      moltnet: {
        node_plans: [],
        server_plans: [
          { base_url: "http://a", id: "a", mode: "managed", network_id: "lab_a", rooms: [] },
          { base_url: "http://b", id: "b", mode: "managed", network_id: "lab_b", rooms: [] },
          // external servers never get a causal mount and must be ignored
          { base_url: "http://external", id: "ext", mode: "external", network_id: "lab_c", rooms: [] }
        ]
      },
      persistent_mounts: [
        { id: "moltnet-lab_a-causal", mount_path: "/a", reason: "a", volume_name: "vol-a" },
        { id: "moltnet-lab_b-causal", mount_path: "/b", reason: "b", volume_name: "vol-b" }
      ]
    }));

    const planned = planArtifactExports(report);
    expect(planned.map((entry) => entry.relativePath).sort()).toEqual([
      "raw/moltnet/lab_a/causal.jsonl",
      "raw/moltnet/lab_a/transcript.json",
      "raw/moltnet/lab_b/causal.jsonl",
      "raw/moltnet/lab_b/transcript.json"
    ]);
  });

  it("plans both events.jsonl and causal.jsonl for a file-backed mneme bank, both optional", () => {
    const report = baseReport(baseContainer({
      memory: [
        {
          accessible_node_ids: ["agent:eleanor"],
          consolidation: { mode: "disabled" },
          declaring_node_id: "team:root",
          id: "office-recall",
          index: {
            graph: { enabled: false },
            lexical: { enabled: false },
            rerank: { enabled: false },
            vector: { enabled: false }
          },
          retention: { forgetting: "manual" },
          store: { kind: "json", path: "/var/lib/spawnfile/memory/office-recall/office-recall.jsonl", persistent_mount_id: "memory-office-recall" },
          transport_by_node_id: { "agent:eleanor": "direct" }
        }
      ],
      persistent_mounts: [
        {
          id: "memory-office-recall",
          mount_path: "/var/lib/spawnfile/memory/office-recall",
          reason: "durable memory stores",
          volume_name: "spawnfile-project-memory-office-recall-abc123"
        }
      ]
    }));

    const planned = planArtifactExports(report);
    expect(planned).toEqual(
      expect.arrayContaining([
        {
          optional: true,
          relativePath: "raw/mneme/office-recall/causal.jsonl",
          source: { kind: "volume", volumeName: "spawnfile-project-memory-office-recall-abc123", volumePath: "memory/causal.jsonl" }
        },
        {
          optional: true,
          relativePath: "raw/mneme/office-recall/events.jsonl",
          source: { kind: "volume", volumeName: "spawnfile-project-memory-office-recall-abc123", volumePath: "memory/events.jsonl" }
        }
      ])
    );
    expect(planned).toHaveLength(2);
  });

  it("skips a memory bank with no persistent mount id (in-memory/ephemeral store)", () => {
    const report = baseReport(baseContainer({
      memory: [
        {
          accessible_node_ids: [],
          consolidation: { mode: "disabled" },
          declaring_node_id: "team:root",
          id: "scratch",
          index: {
            graph: { enabled: false },
            lexical: { enabled: false },
            rerank: { enabled: false },
            vector: { enabled: false }
          },
          retention: { forgetting: "manual" },
          store: { kind: "memory" },
          transport_by_node_id: {}
        }
      ]
    }));

    expect(planArtifactExports(report)).toEqual([]);
  });

  it("plans daimon telemetry from the agent's durable volume, skipping team ids", () => {
    const report = baseReport(baseContainer({
      persistent_mounts: [
        {
          id: "agent-eleanor-daimon-telemetry",
          mount_path: "/spawn/instances/eleanor/runtime/agents/eleanor/telemetry",
          reason: "daimon turn/wake causal telemetry for eleanor",
          volume_name: "spawnfile-project-agent-eleanor-daimon-telemetry-abc123"
        }
      ],
      runtime_instances: [
        {
          config_path: "/agents/eleanor/config",
          home_path: "/spawn/instances/eleanor/home",
          id: "agent-eleanor",
          model_auth_methods: {},
          model_secrets_required: [],
          node_ids: ["agent:eleanor", "team:root"],
          runtime: "pi",
          telemetry_mount_ids: { "agent:eleanor": "agent-eleanor-daimon-telemetry" }
        }
      ]
    }));

    expect(planArtifactExports(report)).toEqual([
      {
        optional: true,
        relativePath: "raw/daimon/eleanor/causal.jsonl",
        source: {
          kind: "volume",
          volumeName: "spawnfile-project-agent-eleanor-daimon-telemetry-abc123",
          volumePath: "causal.jsonl"
        }
      }
    ]);
  });

  it("plans daimon telemetry for a runtime literally named daimon (the pi-app alias), not just pi", () => {
    const report = baseReport(baseContainer({
      persistent_mounts: [
        {
          id: "agent-mapper-daimon-telemetry",
          mount_path: "/spawn/instances/mapper/runtime/agents/mapper/telemetry",
          reason: "daimon turn/wake causal telemetry for mapper",
          volume_name: "spawnfile-project-agent-mapper-daimon-telemetry-abc123"
        }
      ],
      runtime_instances: [
        {
          config_path: "/agents/mapper/config",
          home_path: "/spawn/instances/mapper/home",
          id: "pi-app",
          model_auth_methods: {},
          model_secrets_required: [],
          node_ids: ["agent:mapper"],
          runtime: "daimon",
          telemetry_mount_ids: { "agent:mapper": "agent-mapper-daimon-telemetry" }
        }
      ]
    }));

    expect(planArtifactExports(report)).toEqual([
      {
        optional: true,
        relativePath: "raw/daimon/mapper/causal.jsonl",
        source: {
          kind: "volume",
          volumeName: "spawnfile-project-agent-mapper-daimon-telemetry-abc123",
          volumePath: "causal.jsonl"
        }
      }
    ]);
  });

  it("does not plan daimon telemetry for a non-pi/daimon runtime instance", () => {
    const report = baseReport(baseContainer({
      runtime_instances: [
        {
          config_path: "/agents/analyst/config",
          home_path: "/spawn/instances/analyst/home",
          id: "agent-analyst",
          model_auth_methods: {},
          model_secrets_required: [],
          node_ids: ["agent:analyst"],
          runtime: "openclaw"
        }
      ]
    }));

    expect(planArtifactExports(report)).toEqual([]);
  });

  it("skips a pi runtime instance with no telemetry mount and no home_path", () => {
    const report = baseReport(baseContainer({
      runtime_instances: [
        {
          config_path: "/agents/eleanor/config",
          home_path: null,
          id: "agent-eleanor",
          model_auth_methods: {},
          model_secrets_required: [],
          node_ids: ["agent:eleanor"],
          runtime: "pi"
        }
      ]
    }));

    expect(planArtifactExports(report)).toEqual([]);
  });

  it("falls back to a container-cp source for a legacy report with no telemetry_mount_ids", () => {
    const report = baseReport(baseContainer({
      runtime_instances: [
        {
          config_path: "/agents/eleanor/config",
          home_path: "/spawn/instances/eleanor/home",
          id: "agent-eleanor",
          model_auth_methods: {},
          model_secrets_required: [],
          node_ids: ["agent:eleanor"],
          runtime: "pi"
        }
      ]
    }));

    expect(planArtifactExports(report)).toEqual([
      {
        optional: true,
        relativePath: "raw/daimon/eleanor/causal.jsonl",
        source: {
          kind: "container",
          containerPath: "/spawn/instances/eleanor/runtime/agents/eleanor/telemetry/causal.jsonl"
        }
      }
    ]);
  });

  it("returns an empty plan for a report with no container section", () => {
    expect(planArtifactExports({ diagnostics: [], nodes: [], root: "/project", spawnfile_version: "0.1" })).toEqual([]);
  });

  /**
   * Cost has to survive teardown. `spawnfile usage` reads the ledger live via
   * `docker exec`, which a sealed, torn-down run does not have, so unless export
   * carries the volume the numbers are gone exactly when someone wants them.
   */
  it("plans both usage ledger generations when the daimon usage volume is mounted", () => {
    const report = baseReport(baseContainer({
      persistent_mounts: [
        {
          id: "daimon-grok-usage-ledger",
          lifecycle: "exclusive-reattach",
          mount_path: "/var/lib/spawnfile/daimon/usage",
          reason: "Daimon per-turn engine usage ledger",
          volume_name: "spawnfile-project-daimon-grok-usage-ledger-abc123"
        }
      ]
    }));

    const planned = planArtifactExports(report);

    expect(planned).toEqual([
      {
        optional: true,
        relativePath: "raw/daimon/usage.jsonl",
        source: {
          kind: "volume",
          volumeName: "spawnfile-project-daimon-grok-usage-ledger-abc123",
          volumePath: "usage.jsonl"
        }
      },
      {
        // The rotated generation is not optional-because-unimportant: a deployment
        // long enough to rotate keeps its earlier turns ONLY here, so omitting it
        // silently truncates history for the most expensive runs.
        optional: true,
        relativePath: "raw/daimon/usage.jsonl.1",
        source: {
          kind: "volume",
          volumeName: "spawnfile-project-daimon-grok-usage-ledger-abc123",
          volumePath: "usage.jsonl.1"
        }
      }
    ]);
  });

  it("plans no usage ledger for an organization that was never provisioned the volume", () => {
    // A codex-only org writes no ledger at all and is given no usage mount. Absent
    // must stay absent: nothing planned, rather than an entry that would export as
    // an empty file and read as a genuine zero-cost run.
    const report = baseReport(baseContainer({
      persistent_mounts: [
        {
          id: "daimon-agy-subscription-realm",
          lifecycle: "exclusive-reattach",
          mount_path: "/var/lib/spawnfile/daimon/agy-subscription-realm",
          reason: "AGY subscription realm",
          volume_name: "spawnfile-project-daimon-agy-subscription-realm-abc123"
        }
      ]
    }));

    expect(planArtifactExports(report)).toEqual([]);
  });
});
