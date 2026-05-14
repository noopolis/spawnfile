import { describe, expect, it } from "vitest";

import type { ResolvedAgentNode } from "../../compiler/types.js";

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
});
