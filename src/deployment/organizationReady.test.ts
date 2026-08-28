import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { OrganizationReadinessEvidence } from "../compiler/organizationReadyEvidence.js";
import { dockerDeploymentLabelKeys } from "./dockerLabels.js";
import type { DockerUnitInspection } from "./dockerInspect.js";
import { inspectDockerDeployment } from "./dockerInspect.js";
import type { DeploymentRecord } from "./record.js";
import {
  createOrganizationReadinessPending,
  organizationReadinessFromProbeError,
  parseOrganizationReadiness,
  reconcileOrganizationReadiness
} from "./organizationReady.js";

const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const config = JSON.stringify({ version: "moltnet.node.v1" });
const bindings = JSON.stringify({
  bindings: [{
    capability_manifest_digest: `sha256:${"a".repeat(64)}`,
    json: { auth: "bearer", url: "http://world.example/v1/world" },
    mcp: { auth: "bearer", transport: "streamable_http", url: "http://world.example/mcp" },
    member: { id: "alpha", principal_id: "agent:alpha" },
    run_id: "run-123",
    token_env: "WORLD_ALPHA_TOKEN",
    world_instance_id: "world-123"
  }],
  schema: "simfile.world-bindings.v1"
});

const evidence: OrganizationReadinessEvidence = {
  compileFingerprint: "sf1:0123456789ab",
  compileVersion: "0.1",
  hasExternalMoltnet: false,
  networks: [{
    id: "pitch",
    internalPort: 18789,
    mode: "managed",
    nodes: [{
      configPath: "/var/lib/spawnfile/moltnet/nodes/pitch-alpha.json",
      receiptPath: "/run/spawnfile/moltnet-readiness/pitch-alpha.json",
      memberId: "alpha",
      nodeId: "agent:alpha",
      sha256: digest(config)
    }],
    rooms: [{ id: "field", members: ["alpha"] }]
  }],
  organizationMembers: [{ memberId: "alpha", nodeId: "agent:alpha" }],
  projectLabel: "football",
  version: "spawnfile.organization-ready-evidence.v1",
  worldBindings: {
    artifactPath: "/spawnfile/world-bindings.json",
    assignments: [{ memberId: "alpha", nodeId: "agent:alpha" }],
    digest: digest(bindings),
    schema: "simfile.world-bindings.v1"
  }
};

const record = {
  compileFingerprint: evidence.compileFingerprint,
  deploymentName: "football",
  runId: "run-123",
  unitCount: 1,
  unitId: "football-unit"
};

const inspection = (): DockerUnitInspection => ({
  containerId: "container-opaque",
  drift: [],
  exists: true,
  exitCode: null,
  finishedAt: null,
  identity: {
    compileFingerprint: evidence.compileFingerprint,
    deployment: "football",
    project: "football",
    runId: "run-123",
    unit: "football-unit",
    version: "0.1"
  },
  imageId: "image-opaque",
  message: "running",
  restartCount: 0,
  running: true,
  severity: "ok",
  startedAt: null,
  status: "running",
  unitId: "football-unit"
});

const probe = () => ({
  attachmentReceipts: new Map([[evidence.networks[0]!.nodes[0]!.receiptPath, JSON.stringify({ version: "moltnet.node-readiness.v1", attachments: [{ network_id: "pitch", agent_id: "alpha" }] })]]),
  configs: new Map([[evidence.networks[0]!.nodes[0]!.configPath, config]]),
  networks: [{ healthOk: true, id: "pitch" }],
  worldBindings: bindings
});

const dockerRecord = (): DeploymentRecord => ({
  auth_profile: null,
  compile_fingerprint: evidence.compileFingerprint,
  created_at: "2026-06-11T00:00:00.000Z",
  manager: "docker",
  name: "football",
  output_directory: "/project/.spawn",
  source: { kind: "project", root: "/project" },
  target: { kind: "host", value: "ssh://ops@example" },
  units: [{
    container_id: "container-opaque",
    container_name: "football",
    contains: [{ id: "agent:alpha", kind: "agent" }],
    id: "football-unit",
    image_id: "image-opaque",
    image_tag: "football:latest",
    kind: "container",
    runtime_instances: ["agent-alpha"]
  }],
  version: "spawnfile.deployment.v2"
});

describe("organization readiness reconciliation", () => {
  it("requires an exact Daimon engine receipt for no-world readiness", () => {
    const noWorld = { ...evidence, worldBindings: null, daimon: { receiptPath: "/state/readiness.json", agents: [{ agentId: "agent:alpha", engine: "codex" }] } };
    const baseProbe = { attachmentReceipts: probe().attachmentReceipts, configs: probe().configs, networks: probe().networks, worldBindings: null };
    const valid = JSON.stringify({ version: "noopolis.daimon.readiness-receipt.v1", agents: [{ agent_id: "agent:alpha", engine: "codex" }] });
    expect(reconcileOrganizationReadiness({ evidence: noWorld, inspection: inspection(), record, probe: { ...baseProbe, daimonReceipt: valid } }).state).toBe("ready");
    for (const daimonReceipt of [null, "{", JSON.stringify({ version: "bad", agents: [] }), JSON.stringify({ version: "noopolis.daimon.readiness-receipt.v1", agents: [{}] }), JSON.stringify({ version: "noopolis.daimon.readiness-receipt.v1", agents: [{ agent_id: "agent:alpha", engine: "grok" }] })]) {
      expect(reconcileOrganizationReadiness({ evidence: noWorld, inspection: inspection(), record, probe: { ...baseProbe, daimonReceipt } }).code).toBe("topology_mismatch");
    }
  });
  it("reconciles a healthy never-restarted real-shaped Docker inspection as ready", async () => {
    const labels = {
      [dockerDeploymentLabelKeys.compileFingerprint]: evidence.compileFingerprint,
      [dockerDeploymentLabelKeys.deployment]: "football",
      [dockerDeploymentLabelKeys.project]: evidence.projectLabel,
      [dockerDeploymentLabelKeys.runId]: record.runId,
      [dockerDeploymentLabelKeys.unit]: record.unitId,
      [dockerDeploymentLabelKeys.version]: evidence.compileVersion
    };
    const inspections = await inspectDockerDeployment(dockerRecord(), {
      execFile: async () => ({
        stderr: "",
        stdout: JSON.stringify([{
          Config: { Labels: labels },
          Id: "container-opaque",
          Image: "image-opaque",
          RestartCount: 0,
          State: {
            ExitCode: 0,
            FinishedAt: "",
            Running: true,
            StartedAt: "2026-06-11T00:00:00.000Z",
            Status: "running"
          }
        }])
      })
    });
    const inspection = inspections.get(record.unitId) ?? null;

    expect(reconcileOrganizationReadiness({ evidence, inspection, probe: probe(), record })).toMatchObject({
      code: "organization_ready",
      state: "ready"
    });
  });

  it("accepts only exact immutable evidence and safe live observations", () => {
    expect(reconcileOrganizationReadiness({ evidence, inspection: inspection(), probe: probe(), record })).toEqual({
      code: "organization_ready",
      compile_fingerprint: "sf1:0123456789ab",
      run_id: "run-123",
      state: "ready",
      unit_id: "football-unit",
      version: "spawnfile.organization-ready.v1",
      world_binding_digest: digest(bindings)
    });
  });

  it("does not retain ready across stale, unavailable, restarted, or hostile evidence", () => {
    const stale = createOrganizationReadinessPending(evidence, record);
    expect(stale.state).toBe("pending");
    const missingIdentity = inspection();
    missingIdentity.identity = null;
    const restarted = inspection();
    restarted.restartCount = 1;
    const cases = [
      { label: "missing identity", inspection: missingIdentity, probe: probe(), state: "pending" },
      { label: "restarted", inspection: restarted, probe: probe(), state: "pending" },
      { label: "unhealthy Moltnet", inspection: inspection(), probe: { ...probe(), networks: [{ ...probe().networks[0]!, healthOk: false }] }, state: "failed" },
      { label: "wrong network", inspection: inspection(), probe: { ...probe(), networks: [{ id: "wrong", healthOk: true }] }, state: "failed" },
      { label: "malformed config", inspection: inspection(), probe: { ...probe(), configs: new Map() }, state: "failed" },
      { label: "missing live attachment receipt", inspection: inspection(), probe: { ...probe(), attachmentReceipts: new Map() }, state: "failed" },
      { label: "wrong authenticated attachment", inspection: inspection(), probe: { ...probe(), attachmentReceipts: new Map([[evidence.networks[0]!.nodes[0]!.receiptPath, JSON.stringify({ version: "moltnet.node-readiness.v1", attachments: [{ network_id: "pitch", agent_id: "bravo" }] })]]) }, state: "failed" },
      { label: "wrong-version config", inspection: inspection(), probe: { ...probe(), configs: new Map([[evidence.networks[0]!.nodes[0]!.configPath, JSON.stringify({ version: "moltnet.node.v0" })]]) }, state: "failed" },
      { label: "wrong binding", inspection: inspection(), probe: { ...probe(), worldBindings: bindings.replace("alpha", "bravo") }, state: "failed" },
      { label: "duplicate binding", inspection: inspection(), probe: { ...probe(), worldBindings: bindings.replace("}],\"schema\"", "},{\"member\":{\"id\":\"alpha\"}}],\"schema\"") }, state: "failed" }
    ] as const;
    for (const entry of cases) {
      const result = reconcileOrganizationReadiness({
        evidence,
        inspection: entry.inspection,
        probe: entry.probe,
        record
      });
      expect(result.state, entry.label).toBe(entry.state);
      expect(result.state, entry.label).not.toBe("ready");
    }
  });

  it("rejects every mixed live identity field and external authority", () => {
    for (const key of ["compileFingerprint", "deployment", "project", "runId", "unit", "version"] as const) {
      const live = inspection();
      live.identity = { ...live.identity!, [key]: "wrong" };
      expect(reconcileOrganizationReadiness({ evidence, inspection: live, probe: probe(), record }), key)
        .toMatchObject({ code: "identity_mismatch", state: "failed" });
    }
    expect(reconcileOrganizationReadiness({
      evidence: { ...evidence, hasExternalMoltnet: true }, inspection: inspection(), probe: probe(), record
    })).toMatchObject({ code: "external_moltnet", state: "pending" });
  });

  it("classifies bounded timeout and cancellation terminal values", () => {
    expect(organizationReadinessFromProbeError(evidence, record, new Error("timed out"))).toMatchObject({
      code: "probe_timeout", state: "failed"
    });
    const cancelled = new Error("cancelled");
    cancelled.name = "AbortError";
    expect(organizationReadinessFromProbeError(evidence, record, cancelled)).toMatchObject({
      code: "probe_cancelled", state: "cancelled"
    });
    for (const status of [401, 403, 404]) {
      expect(organizationReadinessFromProbeError(evidence, record, new Error(`HTTP ${status}`))).toMatchObject({
        code: "topology_mismatch", state: "failed"
      });
    }
    expect(organizationReadinessFromProbeError(evidence, record, new Error("HTTP 503"))).toMatchObject({
      code: "probe_unavailable", state: "pending"
    });
    const unavailable = organizationReadinessFromProbeError(
      evidence,
      record,
      new Error("docker probe exit 125: pull denied token=super-secret")
    );
    expect(unavailable).toMatchObject({ code: "probe_unavailable", state: "pending" });
    expect(unavailable.reason).toBe("docker probe exit 125: pull denied token=[redacted]");
    expect(unavailable.reason).not.toContain("super-secret");
  });

  it("rejects prototype, extra, sensitive, malformed, and unknown public values", () => {
    const ready = reconcileOrganizationReadiness({ evidence, inspection: inspection(), probe: probe(), record });
    const hostile = Object.assign(Object.create({ inherited: true }), ready);
    const invalids: unknown[] = [
      { ...ready, token: "secret" },
      { ...ready, code: "raw exception text" },
      { ...ready, state: "unknown" },
      { ...ready, version: "spawnfile.organization-ready.v0" },
      hostile,
      null
    ];
    for (const value of invalids) expect(() => parseOrganizationReadiness(value)).toThrow();
    const serialized = JSON.stringify(ready);
    for (const sentinel of ["AKIAIOSFODNN7EXAMPLE", "raw error", "TOKEN", "http://", "host", "port", "container", "/tmp/"]) {
      expect(serialized).not.toContain(sentinel);
    }
  });
});
