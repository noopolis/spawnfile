import { agentScheduleSchema, type AgentSchedule } from "../../manifest/scheduleSchemas.js";
import { SpawnfileError } from "../../shared/index.js";
import { isEveryScheduleValue, parseEveryScheduleMs } from "../scheduleUtils.js";

type ActiveAgentSchedule = Exclude<AgentSchedule, { kind: "disabled" }>;
type DaimonActiveSchedule = (
  | { kind: "every"; interval_ms: number }
  | { kind: "cron"; cron: string; timezone: string }
) & { prompt: string; jitter_seconds?: number };

const normalizeActiveSchedule = (
  schedule: ActiveAgentSchedule, agentName: string
): DaimonActiveSchedule => {
  const prompt = schedule.prompt ?? "Scheduled work";
  const jitter = schedule.jitter_seconds === undefined ? {} : { jitter_seconds: schedule.jitter_seconds };
  if (schedule.kind === "every") {
    const interval_ms = parseEveryScheduleMs(schedule.every);
    if (interval_ms === null) throw new SpawnfileError("validation_error", `invalid every schedule for ${agentName}`);
    return { kind: "every", interval_ms, prompt, ...jitter };
  }
  return {
    cron: schedule.cron.trim().replace(/\s+/gu, " "),
    kind: "cron",
    prompt,
    timezone: schedule.timezone ?? "UTC",
    ...jitter
  };
};

export const normalizeDaimonSchedule = (
  schedule: AgentSchedule | undefined, agentName: string
): DaimonActiveSchedule | { kind: "disabled" } | undefined => {
  if (!schedule) return undefined;
  if (schedule.kind === "disabled") return { kind: "disabled" };
  return normalizeActiveSchedule(schedule, agentName);
};

const DREAM_PROMPT = "Review the Mneme memory bank as an isolated maintenance task. "
  + "Look for stale or duplicate memories in the agent's current authorized scope. "
  + "Consolidate clear duplicates or outdated information while preserving useful context. "
  + "Make changes only when supported by the records.";

export const normalizeDaimonDreamSchedule = (value: string, agentName: string): DaimonActiveSchedule | undefined => {
  const parsed = agentScheduleSchema.safeParse(isEveryScheduleValue(value)
    ? { kind: "every", every: value, prompt: DREAM_PROMPT }
    : { kind: "cron", cron: value, timezone: "UTC", prompt: DREAM_PROMPT });
  if (!parsed.success || parsed.data.kind === "disabled") return undefined;
  return normalizeActiveSchedule(parsed.data, agentName);
};
