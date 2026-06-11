import { describe, expect, it, vi } from "vitest";

import type { DeploymentRecord, DockerUnitInspection } from "../../deployment/index.js";
import type { ContainerRuntimeInstanceReport } from "../../report/index.js";
import type { RuntimeProbeGateway, RuntimeStatusProbeContext } from "../types.js";
import { picoClawStatusProbes } from "./statusProbes.js";

const scheduleProbe = () => {
  const probe = picoClawStatusProbes.find((entry) => entry.id === "schedule-next-run");
  if (!probe) {
    throw new Error("missing schedule probe");
  }
  return probe;
};

const deployment = {} as DeploymentRecord;
const unit = {} as DeploymentRecord["units"][number];
const inspection = {} as DockerUnitInspection;

const instance = (
  overrides: Partial<ContainerRuntimeInstanceReport> = {}
): ContainerRuntimeInstanceReport => ({
  config_path: "/config.json",
  home_path: "/home",
  id: "agent-runtime",
  model_auth_methods: {},
  model_secrets_required: [],
  runtime: "picoclaw",
  workspace_path: "/workspace",
  ...overrides
});

const context = (
  manager: Partial<RuntimeProbeGateway>,
  runtimeInstance = instance()
): RuntimeStatusProbeContext => ({
  deployment,
  instance: runtimeInstance,
  manager: {
    exec: vi.fn(async () => ({ stderr: "", stdout: "" })),
    httpGet: vi.fn(async () => ({ body: "ok", ok: true })),
    inspectUnit: vi.fn(async () => inspection),
    ...manager
  },
  timeoutMs: 10,
  unit
});

describe("PicoClaw status probes", () => {
  it("reports no next run when the workspace or cron state is missing", async () => {
    const probe = scheduleProbe();

    await expect(probe.run(context({}, instance({ workspace_path: undefined })))).resolves.toEqual([
      {
        key: "schedule.next_run",
        message: "PicoClaw workspace path is not present in the compile report",
        severity: "unknown"
      }
    ]);
    await expect(probe.run(context({
      exec: vi.fn(async () => ({ stderr: "", stdout: "{\"jobs\":[]}" }))
    }))).resolves.toEqual([
      {
        key: "schedule.next_run",
        message: "PicoClaw cron store /workspace/cron/jobs.json has no computed next run",
        severity: "unknown"
      }
    ]);
  });

  it("uses the earliest exposed cron next run", async () => {
    const probe = scheduleProbe();

    const observations = await probe.run(context({
      exec: vi.fn(async () => ({
        stderr: "",
        stdout: JSON.stringify({
          jobs: [
            "bad",
            { id: "late", state: { nextRunAtMs: 1_780_000_000_000 } },
            { state: { next_run_at_ms: 1_779_000_000_000 } }
          ],
          version: 1
        })
      }))
    }));

    expect(observations).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({
          job_id: null,
          next_run_at_ms: 1_779_000_000_000
        }),
        key: "schedule.next_run",
        severity: "ok"
      })
    ]);
  });

  it("normalizes cron store read and parse failures", async () => {
    const probe = scheduleProbe();

    const observations = await probe.run(context({
      exec: vi.fn(async () => ({ stderr: "", stdout: "not json" }))
    }));

    expect(observations[0]).toMatchObject({
      key: "schedule.next_run",
      message: expect.stringContaining("PicoClaw cron store unavailable"),
      severity: "unknown"
    });
  });
});
