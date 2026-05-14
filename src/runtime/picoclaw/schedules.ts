import type { ResolvedAgentNode } from "../../compiler/types.js";
import type { CapabilityReport } from "../../report/index.js";
import { createDiagnostic } from "../common.js";
import type { EmittedFile } from "../types.js";

interface PicoClawCronJob {
  createdAtMs: number;
  deleteAfterRun: boolean;
  enabled: boolean;
  id: string;
  name: string;
  payload: {
    deliver: boolean;
    kind: "agent_turn";
    message: string;
  };
  schedule: {
    expr?: string;
    kind: "cron";
    tz?: string;
  };
  state: Record<string, never>;
  updatedAtMs: number;
}

interface PicoClawCronStore {
  jobs: PicoClawCronJob[];
  version: 1;
}

const createPicoClawCronJob = (node: ResolvedAgentNode): PicoClawCronJob | null => {
  if (!node.schedule || node.schedule.kind !== "cron") {
    return null;
  }

  return {
    createdAtMs: 0,
    deleteAfterRun: false,
    enabled: true,
    id: `spawnfile-${node.name}`,
    name: `spawnfile-${node.name}`,
    payload: {
      deliver: false,
      kind: "agent_turn",
      message: node.schedule.prompt ?? "Run the scheduled Spawnfile task."
    },
    schedule: {
      expr: node.schedule.cron,
      kind: "cron",
      ...(node.schedule.timezone ? { tz: node.schedule.timezone } : {})
    },
    state: {},
    updatedAtMs: 0
  };
};

export const createPicoClawCronStoreFile = (node: ResolvedAgentNode): EmittedFile | null => {
  const job = createPicoClawCronJob(node);
  if (!job) {
    return null;
  }

  const store: PicoClawCronStore = {
    jobs: [job],
    version: 1
  };

  return {
    content: `${JSON.stringify(store, null, 2)}\n`,
    path: "workspace/cron/jobs.json"
  };
};

export const scheduleOutcomeFor = (
  node: ResolvedAgentNode
): { message?: string; outcome?: CapabilityReport["outcome"] } => {
  if (!node.schedule) {
    return {};
  }

  if (node.schedule.kind === "cron") {
    return {
      message: "PicoClaw native cron scheduler is emitted as workspace/cron/jobs.json",
      outcome: "supported"
    };
  }

  if (node.schedule.kind === "disabled") {
    return {
      message: "Disabled schedule emits no wake registration",
      outcome: "supported"
    };
  }

  return {
    message: "PicoClaw native schedule lowering supports cron schedules in Spawnfile v0.1",
    outcome: "degraded"
  };
};

export const createScheduleDiagnostics = (node: ResolvedAgentNode) =>
  node.schedule?.kind === "every"
    ? [
        createDiagnostic(
          "warn",
          "PicoClaw native schedule lowering supports cron schedules in Spawnfile v0.1; every schedules are degraded"
        )
      ]
    : [];
