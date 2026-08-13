import type { ResolvedAgentNode } from "../../compiler/types.js";
import type { CapabilityReport } from "../../report/index.js";
import { slugify } from "../../compiler/helpers.js";
import { createDiagnostic } from "../common.js";
import {
  isMnemeMemoryAccessSupported,
  mnemeMemoryServerName
} from "../mnemeMcp.js";
import { parseEveryScheduleMs } from "../scheduleUtils.js";
import type { EmittedFile } from "../types.js";

type PicoClawCronSchedule =
  | {
      expr?: string;
      kind: "cron";
      tz?: string;
    }
  | {
      everyMs: number;
      kind: "every";
    };

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
  schedule: PicoClawCronSchedule;
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

const dreamPrompt = (bankId: string, serverName: string): string =>
  [
    `Dream over Mneme memory bank ${bankId}.`,
    "This is an isolated memory-maintenance session, not normal conversation.",
    `Prefer the ${serverName} MCP tools when available.`,
    "Search the active dream scope and read-only global scope for stale, duplicate, noisy, or important memories.",
    "Use memory_summarize, memory_register, or memory_forget only when consolidation is evidence-backed."
  ].join(" ");

const scheduleFromMemoryConsolidation = (
  schedule: string
): PicoClawCronSchedule => {
  const everyMs = parseEveryScheduleMs(schedule);
  if (everyMs !== null) {
    return { everyMs, kind: "every" };
  }
  return { expr: schedule, kind: "cron" };
};

const createPicoClawMemoryDreamJobs = (
  node: ResolvedAgentNode
): PicoClawCronJob[] => {
  const jobs: PicoClawCronJob[] = [];
  const seen = new Set<string>();

  for (const access of node.memoryAccess ?? []) {
    const schedule = access.bank.consolidation.schedule;
    if (
      !isMnemeMemoryAccessSupported(access) ||
      access.bank.consolidation.mode !== "scheduled" ||
      !schedule
    ) {
      continue;
    }

    const key = `${access.source}:${access.bank.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const dreamServerName = mnemeMemoryServerName(node, access, "dream");
    const bankSlug = dreamServerName.replace(/^mneme-/u, "").replace(/-dream$/u, "");
    const agentSlug = slugify(node.name) || "agent";
    const id = `spawnfile-dream-${agentSlug}-${bankSlug}`;
    jobs.push({
      createdAtMs: 0,
      deleteAfterRun: false,
      enabled: true,
      id,
      name: id,
      payload: {
        deliver: false,
        kind: "agent_turn",
        message: dreamPrompt(access.bank.id, dreamServerName)
      },
      schedule: scheduleFromMemoryConsolidation(schedule),
      state: {},
      updatedAtMs: 0
    });
  }

  return jobs;
};

export const createPicoClawCronJobs = (
  node: ResolvedAgentNode
): PicoClawCronJob[] =>
  [
    createPicoClawCronJob(node),
    ...createPicoClawMemoryDreamJobs(node)
  ].filter((job): job is PicoClawCronJob => job !== null);

export const createPicoClawCronStoreFile = (node: ResolvedAgentNode): EmittedFile | null => {
  const jobs = createPicoClawCronJobs(node);
  if (jobs.length === 0) {
    return null;
  }

  const store: PicoClawCronStore = {
    jobs,
    version: 1
  };

  return {
    content: `${JSON.stringify(store, null, 2)}\n`,
    path: "workspace/cron/jobs.json"
  };
};

export const hasPicoClawCronJobs = (node: ResolvedAgentNode): boolean =>
  createPicoClawCronJobs(node).length > 0;

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
