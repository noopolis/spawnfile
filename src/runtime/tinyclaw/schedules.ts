import type { ResolvedAgentNode } from "../../compiler/types.js";
import type { CapabilityReport } from "../../report/index.js";
import type { ContainerTargetInput, EmittedFile } from "../types.js";
import { createDiagnostic } from "../common.js";

const TINYCLAW_SCHEDULE_CHANNEL = "schedule";
const TINYCLAW_SCHEDULE_SENDER = "Spawnfile Scheduler";

interface TinyClawSchedule {
  agentId: string;
  channel: string;
  createdAt: number;
  cron: string;
  enabled: boolean;
  id: string;
  label: string;
  message: string;
  sender: string;
}

const createTinyClawSchedule = (node: ResolvedAgentNode): TinyClawSchedule | null => {
  if (!node.schedule || node.schedule.kind !== "cron") {
    return null;
  }

  return {
    agentId: node.name,
    channel: TINYCLAW_SCHEDULE_CHANNEL,
    createdAt: 0,
    cron: node.schedule.cron,
    enabled: true,
    id: `spawnfile-${node.name}`,
    label: `Spawnfile schedule for ${node.name}`,
    message: node.schedule.prompt ?? "Run the scheduled Spawnfile task.",
    sender: TINYCLAW_SCHEDULE_SENDER
  };
};

export const createTinyClawSchedulesFile = (
  inputs: ContainerTargetInput[]
): EmittedFile | null => {
  const schedules = inputs
    .flatMap((input) => {
      if (input.kind !== "agent" || input.value.kind !== "agent") {
        return [];
      }

      return [createTinyClawSchedule(input.value)];
    })
    .filter((schedule): schedule is TinyClawSchedule => Boolean(schedule))
    .sort((left, right) => left.id.localeCompare(right.id));

  return schedules.length > 0
    ? {
        content: `${JSON.stringify(schedules, null, 2)}\n`,
        path: "home/schedules.json"
      }
    : null;
};

export const scheduleOutcomeFor = (
  node: ResolvedAgentNode
): { message?: string; outcome?: CapabilityReport["outcome"] } => {
  if (!node.schedule) {
    return {};
  }

  if (node.schedule.kind === "cron") {
    return {
      message: "TinyClaw native cron scheduler is emitted as schedules.json",
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
    message: "TinyClaw native schedule lowering supports cron schedules in Spawnfile v0.1",
    outcome: "degraded"
  };
};

export const createScheduleDiagnostics = (node: ResolvedAgentNode) =>
  node.schedule?.kind === "every"
    ? [
        createDiagnostic(
          "warn",
          "TinyClaw native schedule lowering supports cron schedules in Spawnfile v0.1; every schedules are degraded"
        )
      ]
    : [];
