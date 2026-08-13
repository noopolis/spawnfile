import { describe, expect, it } from "vitest";

import type {
  ResolvedAgentNode,
  ResolvedMemoryAccess,
  ResolvedMemoryBank
} from "../../compiler/types.js";

import {
  createPicoClawCronStoreFile,
  createScheduleDiagnostics,
  scheduleOutcomeFor
} from "./schedules.js";

const node: ResolvedAgentNode = {
  description: "",
  docs: [],
  env: {},
  execution: {
    model: {
      primary: {
        name: "gpt-4o-mini",
        provider: "openai"
      }
    }
  },
  kind: "agent",
  mcpServers: [],
  name: "assistant",
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: "picoclaw", options: {} },
  secrets: [],
  skills: [],
  source: "/tmp/Spawnfile",
  subagents: []
};

const createBank = (
  id: string,
  schedule: string,
  store: ResolvedMemoryBank["store"] = {
    kind: "json",
    path: "/var/lib/spawnfile/memory/lab/floor.jsonl"
  },
  source = "/tmp/team/Spawnfile"
): ResolvedMemoryBank => ({
  consolidation: { mode: "scheduled", schedule },
  declaredBy: "team",
  declaredName: "lab",
  id,
  index: {
    graph: { enabled: false },
    lexical: { enabled: true },
    rerank: { enabled: false },
    vector: { enabled: false }
  },
  retention: { forgetting: "manual" },
  source,
  store
});

const withMemory = (
  ...banks: ResolvedMemoryBank[]
): ResolvedAgentNode => {
  const memoryAccess: ResolvedMemoryAccess[] = banks.map((bank) => ({
    agentSource: "/tmp/Spawnfile",
    bank,
    declaringKind: "team",
    slotId: "assistant",
    source: bank.source
  }));
  return { ...node, memoryAccess };
};

describe("PicoClaw schedules", () => {
  it("lowers cron schedules into PicoClaw cron jobs", () => {
    const cronFile = createPicoClawCronStoreFile({
      ...node,
      schedule: {
        cron: "*/30 * * * *",
        kind: "cron",
        prompt: "drain the backlog",
        timezone: "UTC"
      }
    });

    expect(JSON.parse(cronFile?.content ?? "{}")).toEqual({
      jobs: [
        {
          createdAtMs: 0,
          deleteAfterRun: false,
          enabled: true,
          id: "spawnfile-assistant",
          name: "spawnfile-assistant",
          payload: {
            deliver: false,
            kind: "agent_turn",
            message: "drain the backlog"
          },
          schedule: {
            expr: "*/30 * * * *",
            kind: "cron",
            tz: "UTC"
          },
          state: {},
          updatedAtMs: 0
        }
      ],
      version: 1
    });
    expect(cronFile?.path).toBe("workspace/cron/jobs.json");
    expect(scheduleOutcomeFor({ ...node, schedule: { cron: "* * * * *", kind: "cron" } }))
      .toMatchObject({ outcome: "supported" });
  });

  it("degrades every schedules because PicoClaw lowering currently emits cron jobs only", () => {
    const scheduledNode: ResolvedAgentNode = {
      ...node,
      schedule: {
        every: "2h",
        kind: "every"
      }
    };

    expect(createPicoClawCronStoreFile(scheduledNode)).toBeNull();
    expect(createScheduleDiagnostics(scheduledNode)[0]).toMatchObject({
      level: "warn",
      message: expect.stringContaining("every schedules are degraded")
    });
    expect(scheduleOutcomeFor(scheduledNode)).toMatchObject({
      outcome: "degraded",
      message: expect.stringContaining("cron schedules")
    });
  });

  it("supports disabled schedules without emitting cron jobs", () => {
    const scheduledNode: ResolvedAgentNode = {
      ...node,
      schedule: {
        kind: "disabled"
      }
    };

    expect(createPicoClawCronStoreFile(scheduledNode)).toBeNull();
    expect(createScheduleDiagnostics(scheduledNode)).toEqual([]);
    expect(scheduleOutcomeFor(scheduledNode)).toMatchObject({
      outcome: "supported",
      message: expect.stringContaining("Disabled schedule")
    });
  });

  it("lowers scheduled memory consolidation into PicoClaw dream cron jobs", () => {
    const cronFile = createPicoClawCronStoreFile(withMemory(createBank("floor", "2s")));
    const store = JSON.parse(cronFile?.content ?? "{}");

    expect(cronFile?.path).toBe("workspace/cron/jobs.json");
    expect(store.jobs[0]).toMatchObject({
      deleteAfterRun: false,
      enabled: true,
      id: "spawnfile-dream-assistant-floor",
      payload: {
        deliver: false,
        kind: "agent_turn",
        message: expect.stringContaining("Dream over Mneme memory bank floor")
      },
      schedule: {
        everyMs: 2000,
        kind: "every"
      }
    });
  });

  it("treats non-duration memory consolidation schedules as cron expressions", () => {
    const cronFile = createPicoClawCronStoreFile(withMemory(createBank("floor", "0 */6 * * *")));
    const store = JSON.parse(cronFile?.content ?? "{}");

    expect(store.jobs[0].schedule).toEqual({
      expr: "0 */6 * * *",
      kind: "cron"
    });
  });

  it("does not emit dream cron jobs for scheduled non-file memory stores", () => {
    const cronFile = createPicoClawCronStoreFile(withMemory(createBank("remote", "2s", {
      dsn_secret: "MEMORY_DSN",
      kind: "postgres"
    })));

    expect(cronFile).toBeNull();
  });

  it("disambiguates duplicate memory ids in dream job names", () => {
    const cronFile = createPicoClawCronStoreFile(withMemory(
      createBank("floor", "2s"),
      createBank("floor", "2s", {
        kind: "json",
        path: "/var/lib/spawnfile/memory/second/floor.jsonl"
      }, "/tmp/second/Spawnfile")
    ));
    const store = JSON.parse(cronFile?.content ?? "{}");
    const ids = store.jobs.map((job: { id: string }) => job.id);

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id: string) => id.startsWith("spawnfile-dream-assistant-floor-"))).toBe(true);
  });
});
