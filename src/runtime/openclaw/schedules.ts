import { slugify } from "../../compiler/helpers.js";
import type { ResolvedAgentNode } from "../../compiler/types.js";
import {
  isMnemeMemoryAccessSupported,
  mnemeMemoryServerName
} from "../mnemeMcp.js";
import { parseEveryScheduleMs } from "../scheduleUtils.js";
import type { EmittedFile } from "../types.js";

type OpenClawCronSchedule =
  | {
      anchorMs?: number;
      everyMs: number;
      kind: "every";
    }
  | {
      expr: string;
      kind: "cron";
      staggerMs?: number;
      tz?: string;
    };

interface OpenClawCronJob {
  agentId: string;
  createdAtMs: number;
  deleteAfterRun: boolean;
  delivery: {
    mode: "none";
  };
  enabled: boolean;
  failureAlert: false;
  id: string;
  name: string;
  payload: {
    deliver: false;
    kind: "agentTurn";
    lightContext: true;
    message: string;
  };
  schedule: OpenClawCronSchedule;
  sessionTarget: "isolated";
  state: Record<string, never>;
  updatedAtMs: number;
  wakeMode: "now";
}

interface OpenClawCronStore {
  jobs: OpenClawCronJob[];
  version: 1;
}

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
): OpenClawCronSchedule => {
  const everyMs = parseEveryScheduleMs(schedule);
  if (everyMs !== null) {
    return { anchorMs: 0, everyMs, kind: "every" };
  }
  return { expr: schedule, kind: "cron", staggerMs: 0 };
};

export const createOpenClawMemoryDreamJobs = (
  node: ResolvedAgentNode
): OpenClawCronJob[] => {
  const jobs: OpenClawCronJob[] = [];
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
      agentId: "main",
      createdAtMs: 0,
      deleteAfterRun: false,
      delivery: { mode: "none" },
      enabled: true,
      failureAlert: false,
      id,
      name: id,
      payload: {
        deliver: false,
        kind: "agentTurn",
        lightContext: true,
        message: dreamPrompt(access.bank.id, dreamServerName)
      },
      schedule: scheduleFromMemoryConsolidation(schedule),
      sessionTarget: "isolated",
      state: {},
      updatedAtMs: 0,
      wakeMode: "now"
    });
  }

  return jobs;
};

export const createOpenClawCronStoreFile = (
  node: ResolvedAgentNode
): EmittedFile | null => {
  const jobs = createOpenClawMemoryDreamJobs(node);
  if (jobs.length === 0) {
    return null;
  }

  const store: OpenClawCronStore = {
    jobs,
    version: 1
  };

  return {
    content: `${JSON.stringify(store, null, 2)}\n`,
    path: "home/.openclaw/cron/jobs.json"
  };
};
