import {
  createRuntimeHttpProbe,
  createRuntimePathProbe
} from "../statusProbes.js";
import type { RuntimeProbeObservation, RuntimeStatusProbe } from "../types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const toString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const cronStorePathFor = (workspacePath: string | undefined): string | null =>
  workspacePath ? `${workspacePath}/cron/jobs.json` : null;

const earliestNextRun = (
  parsed: unknown
): { jobId: string | null; nextRunAtMs: number } | null => {
  const jobs = isRecord(parsed) && Array.isArray(parsed.jobs) ? parsed.jobs : [];
  const dueJobs = jobs.flatMap((job) => {
    if (!isRecord(job)) {
      return [];
    }
    const state = isRecord(job.state) ? job.state : {};
    const nextRunAtMs = toNumber(state.nextRunAtMs ?? state.next_run_at_ms);
    return nextRunAtMs === null
      ? []
      : [{ jobId: toString(job.id), nextRunAtMs }];
  });
  return dueJobs.sort((left, right) => left.nextRunAtMs - right.nextRunAtMs)[0] ?? null;
};

const formatIso = (epochMs: number): string =>
  new Date(epochMs).toISOString();

const createPicoClawScheduleProbe = (): RuntimeStatusProbe => ({
  id: "schedule-next-run",
  label: "PicoClaw schedule next run",
  async run(context): Promise<RuntimeProbeObservation[]> {
    const cronStorePath = cronStorePathFor(context.instance.workspace_path);
    if (!cronStorePath) {
      return [{
        key: "schedule.next_run",
        message: "PicoClaw workspace path is not present in the compile report",
        severity: "unknown"
      }];
    }

    try {
      const result = await context.manager.exec(["cat", cronStorePath]);
      const nextRun = earliestNextRun(JSON.parse(result.stdout) as unknown);
      if (!nextRun) {
        return [{
          key: "schedule.next_run",
          message: `PicoClaw cron store ${cronStorePath} has no computed next run`,
          severity: "unknown"
        }];
      }
      return [{
        details: {
          job_id: nextRun.jobId,
          next_run_at: formatIso(nextRun.nextRunAtMs),
          next_run_at_ms: nextRun.nextRunAtMs
        },
        key: "schedule.next_run",
        message: `next scheduled PicoClaw wake for ${nextRun.jobId ?? "job"} at ${formatIso(nextRun.nextRunAtMs)}`,
        severity: "ok"
      }];
    } catch (error) {
      return [{
        key: "schedule.next_run",
        message: `PicoClaw cron store unavailable at ${cronStorePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        severity: "unknown"
      }];
    }
  }
});

export const picoClawStatusProbes: RuntimeStatusProbe[] = [
  createRuntimePathProbe({
    id: "home",
    key: "runtime.home",
    label: "PicoClaw home",
    pathFor: (instance) => instance.home_path,
    testFlag: "-d"
  }),
  createRuntimePathProbe({
    id: "workspace",
    key: "runtime.workspace",
    label: "PicoClaw workspace",
    pathFor: (instance) => instance.workspace_path,
    testFlag: "-d"
  }),
  createRuntimePathProbe({
    id: "config",
    key: "runtime.config",
    label: "PicoClaw config",
    pathFor: (instance) => instance.config_path,
    testFlag: "-f"
  }),
  createRuntimeHttpProbe({
    id: "health",
    key: "runtime.health",
    label: "PicoClaw health",
    path: "/health",
    portFor: (instance) => instance.internal_port
  }),
  createRuntimeHttpProbe({
    id: "ready",
    key: "runtime.ready",
    label: "PicoClaw readiness",
    path: "/ready",
    portFor: (instance) => instance.internal_port
  }),
  createPicoClawScheduleProbe()
];
