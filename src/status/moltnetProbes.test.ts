import { describe, expect, it, vi } from "vitest";

import type { DeploymentRecord, DockerInspectionResult } from "../deployment/index.js";
import type { LoadedCompileReport, StatusReportMoltnetServerPlan } from "./compileReport.js";
import { collectMoltnetProbeObservations } from "./moltnetProbes.js";

const serverPlan = (overrides: Partial<StatusReportMoltnetServerPlan> = {}): StatusReportMoltnetServerPlan => ({
  authMode: "bearer", baseUrl: "https://moltnet.example", directMessages: false, id: "root-local_lab",
  mode: "external", networkId: "local_lab", operatorTokenSecret: "MOLTNET_OPERATOR_TOKEN", port: null,
  publicRead: false, rooms: [], storeKind: null, ...overrides
});

const loadedReport = (server: StatusReportMoltnetServerPlan): LoadedCompileReport => ({
  kind: "loaded",
  report: { compileFingerprint: "sf1:abc", generatedAt: "2026-06-11T00:00:00.000Z", moltnetServers: [server], nodes: [], outputDirectory: "/project/.spawn", reportPath: "/project/.spawn/report.json", root: "/project/Spawnfile", runtimeInstances: [] },
  reportPath: "/project/.spawn/report.json"
});

const deployment = (): DeploymentRecord => ({
  auth_profile: null, compile_fingerprint: "sf1:abc", created_at: "2026-06-11T00:00:00.000Z", manager: "docker",
  name: "default", output_directory: "/project/.spawn", source: { kind: "project", root: "/project" },
  target: { kind: "host", value: "ssh://ops@example" }, units: [{ container_id: "container-123", container_name: "project", contains: [], id: "default-container", image_id: "image-123", image_tag: "project:latest", kind: "container", runtime_instances: [] }], version: "spawnfile.deployment.v2"
});

const inspections = (): Map<string, DockerInspectionResult> => new Map([["default", new Map([["default-container", {
  containerId: "container-123", drift: [], exists: true, exitCode: 0, finishedAt: null, identity: null, imageId: "image-123", message: "running", restartCount: 0, running: true, severity: "ok", startedAt: "2026-06-11T00:00:00.000Z", status: "running", unitId: "default-container"
}]])]]);

describe("Moltnet live health probes", () => {
  it("does nothing without a loaded report", async () => {
    await expect(collectMoltnetProbeObservations({ deployments: [], inspections: new Map(), loadedReport: { kind: "missing", reportPath: "/missing" } })).resolves.toEqual([]);
  });

  it("probes external health without headers, JSON parsing, or auth", async () => {
    const fetchHealth = vi.fn(async (url: string, timeoutMs: number) => {
      expect(url).toBe("https://moltnet.example/healthz");
      expect(timeoutMs).toBe(25);
      return { ok: true };
    });
    const observations = await collectMoltnetProbeObservations({
      authValues: { MOLTNET_OPERATOR_TOKEN: "secret-sentinel" }, deployments: [], fetchHealth, inspections: new Map(), loadedReport: loadedReport(serverPlan()), timeoutMs: 25
    });
    expect(fetchHealth).toHaveBeenCalledOnce();
    expect(observations).toContainEqual(expect.objectContaining({ key: "network.reachable", severity: "ok", subject: "network:local_lab" }));
    expect(JSON.stringify(observations)).not.toContain("secret-sentinel");
  });

  it("probes managed health through the same-image network helper", async () => {
    const record = deployment();
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      expect(args).toContain("run");
      expect(args).toContain("--network");
      expect(args).not.toContain("exec");
      return { stderr: "", stdout: "healthy\n200" };
    });
    const observations = await collectMoltnetProbeObservations({
      deployments: [record], execFile, inspections: inspections(), loadedReport: loadedReport(serverPlan({ mode: "managed", port: 8787, baseUrl: "http://127.0.0.1:8787" }))
    });
    expect(observations[0]).toMatchObject({ key: "network.reachable", severity: "ok" });
  });

  it("reports rejected, timeout, missing-unit, and missing-port health", async () => {
    const rejected = await collectMoltnetProbeObservations({ deployments: [], fetchHealth: async () => ({ error: "HTTP 503", ok: false }), inspections: new Map(), loadedReport: loadedReport(serverPlan()) });
    expect(rejected[0]).toMatchObject({ severity: "unknown", message: expect.stringContaining("HTTP 503") });
    const managed = serverPlan({ mode: "managed", port: null });
    const missingPort = await collectMoltnetProbeObservations({ deployments: [deployment()], inspections: inspections(), loadedReport: loadedReport(managed) });
    expect(missingPort[0]).toMatchObject({ severity: "unknown", message: expect.stringContaining("no internal port") });
    const missingUnit = await collectMoltnetProbeObservations({ deployments: [], inspections: new Map(), loadedReport: loadedReport({ ...managed, port: 8787 }) });
    expect(missingUnit[0]).toMatchObject({ severity: "unknown" });
  });
});
