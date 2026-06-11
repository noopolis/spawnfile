import { describe, expect, it, vi } from "vitest";

import type { DeploymentRecord, DockerInspectionResult } from "../deployment/index.js";
import { openClawAdapter } from "../runtime/openclaw/adapter.js";
import type { LoadedCompileReport } from "./compileReport.js";
import { collectRuntimeProbeObservations } from "./runtimeProbes.js";

const deployment = (): DeploymentRecord => ({
  auth_profile: null,
  compile_fingerprint: "sf1:abc",
  created_at: "2026-06-11T00:00:00.000Z",
  manager: "docker",
  name: "default",
  output_directory: "/project/.spawn",
  project_root: "/project",
  target: { kind: "host", value: "ssh://ops@example" },
  units: [
    {
      container_id: "container-123",
      container_name: "project",
      contains: [{ id: "agent:analyst", kind: "agent" }],
      id: "default-container",
      image_id: "image-123",
      image_tag: "project:latest",
      kind: "container",
      runtime_instances: ["agent-analyst"]
    }
  ],
  version: "spawnfile.deployment.v1"
});

const loadedReport = (runtime = "openclaw"): LoadedCompileReport => ({
  kind: "loaded",
  report: {
    compileFingerprint: "sf1:abc",
    generatedAt: "2026-06-11T00:00:00.000Z",
    nodes: [],
    outputDirectory: "/project/.spawn",
    reportPath: "/project/.spawn/spawnfile-report.json",
    root: "/project/Spawnfile",
    runtimeInstances: [
      {
        configPath: "/instances/agent-analyst/openclaw.json",
        homePath: "/instances/agent-analyst/home",
        id: "agent-analyst",
        internalPort: 18789,
        nodeIds: ["agent:analyst"],
        publishedPort: 18789,
        runtime,
        workspacePath: "/instances/agent-analyst/workspace"
      }
    ]
  },
  reportPath: "/project/.spawn/spawnfile-report.json"
});

const runningInspection = (): DockerInspectionResult => new Map([
  ["default-container", {
    containerId: "container-123",
    drift: [],
    exists: true,
    exitCode: 0,
    finishedAt: null,
    imageId: "image-123",
    message: "running",
    restartCount: 0,
    running: true,
    severity: "ok",
    startedAt: "2026-06-11T00:00:00.000Z",
    status: "running",
    unitId: "default-container"
  }]
]);

describe("runtime probe collection", () => {
  it("runs adapter-owned probes through the Docker probe gateway", async () => {
    const record = deployment();
    const execFile = vi.fn(async (_file: string, args: string[]) => ({
      stderr: "",
      stdout: args.includes("curl") ? "{\"status\":\"ok\"}\n" : ""
    }));

    const observations = await collectRuntimeProbeObservations({
      deployments: [record],
      execFile,
      inspections: new Map([[record.name, runningInspection()]]),
      loadedReport: loadedReport(),
      timeoutMs: 25
    });

    expect(observations).toContainEqual(expect.objectContaining({
      key: "runtime.health",
      severity: "ok",
      source: "runtime",
      subject: "runtime-instance:agent-analyst"
    }));
    expect(execFile).toHaveBeenCalledWith(
      "docker",
      ["--host", "ssh://ops@example", "exec", "container-123", "curl", "-fsS", "http://127.0.0.1:18789/healthz"],
      { timeout: 25 }
    );
  });

  it("reports PicoClaw schedule next-run metadata when the cron store exposes it", async () => {
    const record = deployment();
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("cat")) {
        return {
          stderr: "",
          stdout: JSON.stringify({
            jobs: [
              {
                id: "spawnfile-analyst",
                state: { nextRunAtMs: 1_780_000_000_000 }
              }
            ],
            version: 1
          })
        };
      }
      return { stderr: "", stdout: args.includes("curl") ? "{\"status\":\"ok\"}\n" : "" };
    });

    const observations = await collectRuntimeProbeObservations({
      deployments: [record],
      execFile,
      inspections: new Map([[record.name, runningInspection()]]),
      loadedReport: loadedReport("picoclaw"),
      timeoutMs: 25
    });

    expect(observations).toContainEqual(expect.objectContaining({
      details: expect.objectContaining({
        job_id: "spawnfile-analyst",
        next_run_at_ms: 1_780_000_000_000
      }),
      key: "schedule.next_run",
      severity: "ok",
      source: "runtime",
      subject: "runtime-instance:agent-analyst"
    }));
    expect(execFile).toHaveBeenCalledWith(
      "docker",
      ["--host", "ssh://ops@example", "exec", "container-123", "cat", "/instances/agent-analyst/workspace/cron/jobs.json"],
      { timeout: 25 }
    );
  });

  it("reports missing instances, stopped units, and unknown adapters without throwing", async () => {
    const missingRecord = deployment();
    missingRecord.units[0]!.runtime_instances = ["missing-instance"];
    const stoppedRecord = deployment();
    stoppedRecord.name = "stopped";
    const unknownRuntimeRecord = deployment();
    unknownRuntimeRecord.name = "unknown-runtime";
    const stoppedInspection: DockerInspectionResult = new Map([
      ["default-container", {
        ...runningInspection().get("default-container")!,
        running: false,
        severity: "error",
        status: "exited"
      }]
    ]);

    const observations = await collectRuntimeProbeObservations({
      deployments: [missingRecord, stoppedRecord, unknownRuntimeRecord],
      execFile: async () => ({ stderr: "", stdout: "" }),
      inspections: new Map([
        [missingRecord.name, runningInspection()],
        [stoppedRecord.name, stoppedInspection],
        [unknownRuntimeRecord.name, runningInspection()]
      ]),
      loadedReport: loadedReport("unknownclaw")
    });

    expect(observations).toContainEqual(expect.objectContaining({
      key: "runtime.instance",
      severity: "warn",
      subject: "runtime-instance:missing-instance"
    }));
    expect(observations).toContainEqual(expect.objectContaining({
      key: "runtime.probe",
      severity: "error",
      subject: "runtime-instance:agent-analyst"
    }));
    expect(observations).toContainEqual(expect.objectContaining({
      key: "runtime.adapter",
      severity: "unknown",
      subject: "runtime-instance:agent-analyst"
    }));
  });

  it("skips runtime probing for missing reports and missing live inspections", async () => {
    await expect(collectRuntimeProbeObservations({
      deployments: [deployment()],
      execFile: async () => ({ stderr: "", stdout: "" }),
      inspections: new Map(),
      loadedReport: { kind: "missing", reportPath: "/project/.spawn/spawnfile-report.json" }
    })).resolves.toEqual([]);

    const observations = await collectRuntimeProbeObservations({
      deployments: [deployment()],
      execFile: async () => ({ stderr: "", stdout: "" }),
      inspections: new Map(),
      loadedReport: loadedReport()
    });

    expect(observations).toContainEqual(expect.objectContaining({
      key: "runtime.probe",
      severity: "unknown",
      subject: "runtime-instance:agent-analyst"
    }));
  });

  it("reports adapters without probes and probe handler failures", async () => {
    const originalProbes = openClawAdapter.statusProbes;
    try {
      openClawAdapter.statusProbes = [];
      const noProbeObservations = await collectRuntimeProbeObservations({
        deployments: [deployment()],
        execFile: async () => ({ stderr: "", stdout: "" }),
        inspections: new Map([[deployment().name, runningInspection()]]),
        loadedReport: loadedReport()
      });

      openClawAdapter.statusProbes = [{
        id: "boom",
        label: "Boom",
        run: async () => {
          throw new Error("probe exploded");
        }
      }];
      const thrownObservations = await collectRuntimeProbeObservations({
        deployments: [deployment()],
        execFile: async () => ({ stderr: "", stdout: "" }),
        inspections: new Map([[deployment().name, runningInspection()]]),
        loadedReport: loadedReport()
      });

      openClawAdapter.statusProbes = [{
        id: "string-boom",
        label: "String Boom",
        run: async () => {
          throw "string failure";
        }
      }];
      const stringThrownObservations = await collectRuntimeProbeObservations({
        deployments: [deployment()],
        execFile: async () => ({ stderr: "", stdout: "" }),
        inspections: new Map([[deployment().name, runningInspection()]]),
        loadedReport: loadedReport()
      });

      expect(noProbeObservations).toContainEqual(expect.objectContaining({
        key: "runtime.probe",
        message: "openclaw has no status probes",
        severity: "unknown"
      }));
      expect(thrownObservations).toContainEqual(expect.objectContaining({
        key: "runtime.boom",
        message: expect.stringContaining("probe exploded"),
        severity: "unknown"
      }));
      expect(stringThrownObservations).toContainEqual(expect.objectContaining({
        key: "runtime.string-boom",
        message: expect.stringContaining("string failure"),
        severity: "unknown"
      }));
    } finally {
      openClawAdapter.statusProbes = originalProbes;
    }
  });

  it("passes normalized runtime instance paths to adapter probes", async () => {
    const originalProbes = openClawAdapter.statusProbes;
    try {
      openClawAdapter.statusProbes = [{
        id: "echo-instance",
        label: "Echo Instance",
        run: async ({ instance }) => [{
          details: {
            config_path: instance.config_path,
            home_path: instance.home_path,
            workspace_path: instance.workspace_path
          },
          key: "runtime.instance.paths",
          message: "runtime instance paths normalized",
          severity: "ok"
        }]
      }];
      const report = loadedReport();
      if (report.kind === "loaded") {
        report.report.runtimeInstances[0] = {
          ...report.report.runtimeInstances[0]!,
          configPath: null,
          homePath: null,
          workspacePath: null
        };
      }

      const observations = await collectRuntimeProbeObservations({
        deployments: [deployment()],
        execFile: async () => ({ stderr: "", stdout: "" }),
        inspections: new Map([[deployment().name, runningInspection()]]),
        loadedReport: report
      });

      expect(observations).toContainEqual(expect.objectContaining({
        details: {
          config_path: "",
          home_path: null,
          workspace_path: undefined
        },
        key: "runtime.instance.paths",
        severity: "ok"
      }));
    } finally {
      openClawAdapter.statusProbes = originalProbes;
    }
  });
});
