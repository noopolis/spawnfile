import { describe, expect, it, vi } from "vitest";

import type { LoadedCompileReport, StatusReport } from "./compileReport.js";
import { collectLifecycleProbeObservations } from "./lifecycleProbes.js";
import type { StatusObservation } from "./types.js";

const PI_APP_SOURCE = [
  "const foo = 1;",
  "// operator route: /spawnfile/agents/:slug/wake",
  'const CONTROL_TOKEN_ENV = "SPAWNFILE_PI_CONTROL_TOKEN";',
  'return { ok: false, reason: "no operator token configured (" + CONTROL_TOKEN_ENV + " is unset)" };'
].join("\n");

const ENTRYPOINT_WITH_RUN_ID = "#!/usr/bin/env bash\nNOOPOLIS_RUN_ID='run-1' exec node app.mjs\n";
const ENTRYPOINT_WITHOUT_RUN_ID = "#!/usr/bin/env bash\nexec node app.mjs\n";

const loadedReport = (overrides: Partial<StatusReport> = {}): LoadedCompileReport => ({
  kind: "loaded",
  report: {
    compileFingerprint: "sf1:abc",
    entrypointPath: "/out/entrypoint.sh",
    generatedAt: "2026-06-11T00:00:00.000Z",
    nodes: [
      { capabilities: [], diagnostics: [], id: "agent:analyst", kind: "agent", outputDir: null, runtime: "pi" },
      { capabilities: [], diagnostics: [], id: "agent:writer", kind: "agent", outputDir: null, runtime: "openclaw" }
    ],
    outputDirectory: "/out",
    reportPath: "/out/spawnfile-report.json",
    root: "/project/Spawnfile",
    runtimeInstances: [
      {
        configPath: "/instances/pi/agent-analyst/pi/pi-app.json",
        homePath: "/instances/pi/agent-analyst/home",
        id: "pi-analyst",
        internalPort: 19690,
        nodeIds: ["agent:analyst"],
        publishedPort: null,
        runtime: "pi",
        workspacePath: "/instances/pi/agent-analyst/workspace"
      },
      {
        configPath: "/instances/openclaw/agent-writer/openclaw.json",
        homePath: "/instances/openclaw/agent-writer/home",
        id: "openclaw-writer",
        internalPort: 18789,
        nodeIds: ["agent:writer"],
        publishedPort: 18789,
        runtime: "openclaw",
        workspacePath: "/instances/openclaw/agent-writer/workspace"
      }
    ],
    ...overrides
  },
  reportPath: "/out/spawnfile-report.json"
});

const observationFor = (observations: StatusObservation[], key: string, subject: string) =>
  observations.find((entry) => entry.key === key && entry.subject === subject);

describe("collectLifecycleProbeObservations", () => {
  it("reports unknown for every lifecycle key when the compile report is missing", async () => {
    const observations = await collectLifecycleProbeObservations({
      loadedReport: { kind: "missing", reportPath: "/out/spawnfile-report.json" },
      outputDirectory: "/out",
      readFile: vi.fn(async () => null)
    });

    expect(observations).toHaveLength(5);
    expect(observations.every((entry) => entry.severity === "unknown")).toBe(true);
    expect(observations.map((entry) => entry.key).sort()).toEqual([
      "lifecycle.instance.coverage",
      "lifecycle.instance.paths",
      "lifecycle.instance.runtime",
      "lifecycle.run_id",
      "lifecycle.wake.operator"
    ]);
  });

  it("marks instance coverage ok when every agent node is covered, error when not", async () => {
    const readFile = vi.fn(async () => PI_APP_SOURCE);
    const observations = await collectLifecycleProbeObservations({
      loadedReport: loadedReport(),
      outputDirectory: "/out",
      readFile
    });

    const covered = observationFor(observations, "lifecycle.instance.coverage", "agent:analyst");
    expect(covered?.severity).toBe("ok");
    const alsoCovered = observationFor(observations, "lifecycle.instance.coverage", "agent:writer");
    expect(alsoCovered?.severity).toBe("ok");
  });

  it("flags an uncovered agent node as an error", async () => {
    const report = loadedReport();
    if (report.kind === "loaded") {
      report.report.runtimeInstances = report.report.runtimeInstances.filter((instance) => instance.id !== "openclaw-writer");
    }
    const observations = await collectLifecycleProbeObservations({
      loadedReport: report,
      outputDirectory: "/out",
      readFile: vi.fn(async () => PI_APP_SOURCE)
    });

    const uncovered = observationFor(observations, "lifecycle.instance.coverage", "agent:writer");
    expect(uncovered?.severity).toBe("error");
  });

  it("resolves the runtime adapter for each instance, erroring on an unknown runtime", async () => {
    const report = loadedReport();
    if (report.kind === "loaded") {
      report.report.runtimeInstances[1]!.runtime = "not-a-real-runtime";
    }
    const observations = await collectLifecycleProbeObservations({
      loadedReport: report,
      outputDirectory: "/out",
      readFile: vi.fn(async () => PI_APP_SOURCE)
    });

    expect(observationFor(observations, "lifecycle.instance.runtime", "runtime-instance:pi-analyst")?.severity).toBe("ok");
    expect(observationFor(observations, "lifecycle.instance.runtime", "runtime-instance:openclaw-writer")?.severity).toBe("error");
  });

  it("warns on missing homePath/workspacePath and errors on missing configPath", async () => {
    const report = loadedReport();
    if (report.kind === "loaded") {
      report.report.runtimeInstances[1]!.homePath = null;
      report.report.runtimeInstances[0]!.configPath = null;
    }
    const observations = await collectLifecycleProbeObservations({
      loadedReport: report,
      outputDirectory: "/out",
      readFile: vi.fn(async () => PI_APP_SOURCE)
    });

    expect(observationFor(observations, "lifecycle.instance.paths", "runtime-instance:openclaw-writer")?.severity).toBe("warn");
    expect(observationFor(observations, "lifecycle.instance.paths", "runtime-instance:pi-analyst")?.severity).toBe("error");
  });

  it("warns with just workspacePath missing when homePath is present", async () => {
    const report = loadedReport();
    if (report.kind === "loaded") {
      report.report.runtimeInstances[1]!.workspacePath = null;
    }
    const observations = await collectLifecycleProbeObservations({
      loadedReport: report,
      outputDirectory: "/out",
      readFile: vi.fn(async () => PI_APP_SOURCE)
    });

    const observation = observationFor(observations, "lifecycle.instance.paths", "runtime-instance:openclaw-writer");
    expect(observation?.severity).toBe("warn");
    expect(observation?.message).toContain("workspacePath");
    expect(observation?.message).not.toContain("homePath and workspacePath");
  });

  it("checks the B62 operator wake route only for pi/daimon instances", async () => {
    const readFile = vi.fn(async (filePath: string) =>
      filePath.includes("/opt/spawnfile/runtime-installs/pi/app.mjs") ? PI_APP_SOURCE : null);
    const observations = await collectLifecycleProbeObservations({
      loadedReport: loadedReport(),
      outputDirectory: "/out",
      readFile
    });

    expect(readFile).toHaveBeenCalledWith("/out/container/rootfs/opt/spawnfile/runtime-installs/pi/app.mjs");
    expect(observationFor(observations, "lifecycle.wake.operator", "runtime-instance:pi-analyst")?.severity).toBe("ok");
    expect(observationFor(observations, "lifecycle.wake.operator", "runtime-instance:openclaw-writer")?.severity).toBe("unknown");
  });

  it("errors when the generated pi app is unreadable, and errors when markers are missing", async () => {
    const missing = await collectLifecycleProbeObservations({
      loadedReport: loadedReport(),
      outputDirectory: "/out",
      readFile: vi.fn(async () => null)
    });
    expect(observationFor(missing, "lifecycle.wake.operator", "runtime-instance:pi-analyst")?.severity).toBe("error");

    const stripped = await collectLifecycleProbeObservations({
      loadedReport: loadedReport(),
      outputDirectory: "/out",
      readFile: vi.fn(async () => "const app = 1;")
    });
    const strippedObservation = observationFor(stripped, "lifecycle.wake.operator", "runtime-instance:pi-analyst");
    expect(strippedObservation?.severity).toBe("error");
    expect(strippedObservation?.message).toContain("operator wake route");
    expect(strippedObservation?.message).toContain("SPAWNFILE_PI_CONTROL_TOKEN");
    expect(strippedObservation?.message).toContain("fail-closed gate");
  });

  it("reports unknown for the wake operator probe when there is no compiled output directory", async () => {
    const observations = await collectLifecycleProbeObservations({
      loadedReport: loadedReport(),
      outputDirectory: null,
      readFile: vi.fn(async () => PI_APP_SOURCE)
    });

    expect(observationFor(observations, "lifecycle.wake.operator", "runtime-instance:pi-analyst")?.severity).toBe("unknown");
  });

  it("reports run_id ok when the entrypoint stamps NOOPOLIS_RUN_ID", async () => {
    const observations = await collectLifecycleProbeObservations({
      loadedReport: loadedReport(),
      outputDirectory: "/out",
      readFile: vi.fn(async (filePath: string) =>
        filePath === "/out/entrypoint.sh" ? ENTRYPOINT_WITH_RUN_ID : PI_APP_SOURCE)
    });

    const runId = observationFor(observations, "lifecycle.run_id", "compile");
    expect(runId?.severity).toBe("ok");
  });

  it("reports run_id unknown, never ok, when the entrypoint lacks NOOPOLIS_RUN_ID", async () => {
    const observations = await collectLifecycleProbeObservations({
      loadedReport: loadedReport(),
      outputDirectory: "/out",
      readFile: vi.fn(async (filePath: string) =>
        filePath === "/out/entrypoint.sh" ? ENTRYPOINT_WITHOUT_RUN_ID : PI_APP_SOURCE)
    });

    const runId = observationFor(observations, "lifecycle.run_id", "compile");
    expect(runId?.severity).toBe("unknown");
    expect(runId?.message).toBe("not compiled with a run id");
  });

  it("reports run_id unknown when there is no entrypointPath at all", async () => {
    const report = loadedReport({ entrypointPath: null });
    const observations = await collectLifecycleProbeObservations({
      loadedReport: report,
      outputDirectory: "/out",
      readFile: vi.fn(async () => ENTRYPOINT_WITH_RUN_ID)
    });

    const runId = observationFor(observations, "lifecycle.run_id", "compile");
    expect(runId?.severity).toBe("unknown");
  });
});
