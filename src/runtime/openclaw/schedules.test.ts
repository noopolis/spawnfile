import { describe, expect, it } from "vitest";

import type {
  ResolvedAgentNode,
  ResolvedMemoryAccess,
  ResolvedMemoryBank
} from "../../compiler/types.js";

import { createOpenClawCronStoreFile } from "./schedules.js";

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

const createNode = (...banks: ResolvedMemoryBank[]): ResolvedAgentNode => {
  const memoryAccess: ResolvedMemoryAccess[] = banks.map((bank) => ({
    agentSource: "/tmp/agent/Spawnfile",
    bank,
    declaringKind: "team",
    slotId: "assistant",
    source: bank.source
  }));

  return {
    description: "",
    docs: [],
    env: {},
    execution: undefined,
    kind: "agent",
    mcpServers: [],
    memoryAccess,
    name: "assistant",
    policyMode: null,
    policyOnDegrade: null,
    runtime: { name: "openclaw", options: {} },
    secrets: [],
    skills: [],
    source: "/tmp/agent/Spawnfile",
    subagents: []
  };
};

describe("OpenClaw schedules", () => {
  it("lowers scheduled memory consolidation into isolated dream cron jobs", () => {
    const file = createOpenClawCronStoreFile(createNode(createBank("floor", "5m")));
    const store = JSON.parse(file?.content ?? "{}");

    expect(file?.path).toBe("home/.openclaw/cron/jobs.json");
    expect(store.jobs[0]).toMatchObject({
      agentId: "main",
      delivery: { mode: "none" },
      enabled: true,
      id: "spawnfile-dream-assistant-floor",
      payload: {
        deliver: false,
        kind: "agentTurn",
        lightContext: true,
        message: expect.stringContaining("Dream over Mneme memory bank floor")
      },
      schedule: {
        anchorMs: 0,
        everyMs: 300000,
        kind: "every"
      },
      sessionTarget: "isolated",
      wakeMode: "now"
    });
  });

  it("treats non-duration consolidation schedules as cron expressions", () => {
    const file = createOpenClawCronStoreFile(createNode(createBank("floor", "0 */6 * * *")));
    const store = JSON.parse(file?.content ?? "{}");

    expect(store.jobs[0].schedule).toEqual({
      expr: "0 */6 * * *",
      kind: "cron",
      staggerMs: 0
    });
  });

  it("does not emit dream cron jobs for scheduled non-file memory stores", () => {
    const file = createOpenClawCronStoreFile(createNode(createBank("remote", "5m", {
      dsn_secret: "MEMORY_DSN",
      kind: "postgres"
    })));

    expect(file).toBeNull();
  });

  it("disambiguates duplicate memory ids in dream job names", () => {
    const file = createOpenClawCronStoreFile(createNode(
      createBank("floor", "5m"),
      createBank("floor", "5m", {
        kind: "json",
        path: "/var/lib/spawnfile/memory/second/floor.jsonl"
      }, "/tmp/second/Spawnfile")
    ));
    const store = JSON.parse(file?.content ?? "{}");
    const ids = store.jobs.map((job: { id: string }) => job.id);

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id: string) => id.startsWith("spawnfile-dream-assistant-floor-"))).toBe(true);
  });
});
