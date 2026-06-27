import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { renderPiActivitySource } from "./appActivitySource.js";

interface ActivityBroker {
  list: (filter?: string | null, tail?: string | null) => Record<string, unknown>[];
  publish: (event: Record<string, unknown>) => Record<string, unknown>;
}

interface ActivityHarness {
  createActivityBroker: () => ActivityBroker;
  formatActivityError: (error: unknown) => string;
}

const loadHarness = (): ActivityHarness =>
  runInNewContext(`${renderPiActivitySource()}\n({ createActivityBroker, formatActivityError });`) as ActivityHarness;

describe("renderPiActivitySource", () => {
  it("creates a filtered and tailed activity buffer with normalized event fields", () => {
    const { createActivityBroker } = loadHarness();
    const broker = createActivityBroker();

    broker.publish({
      agent_id: "agent:mapper",
      agent_name: "Mapper",
      agent_slug: "mapper",
      type: "agent.loaded"
    });
    broker.publish({
      agent_id: "agent:reviewer",
      agent_name: "Reviewer",
      agent_slug: "reviewer",
      type: "agent.turn.started",
      wake_id: "wake-1",
      wake_kind: "message"
    });
    broker.publish({
      agent_id: "agent:mapper",
      agent_name: "Mapper",
      agent_slug: "mapper",
      type: "agent.turn.completed",
      wake_id: "wake-2",
      wake_kind: "schedule"
    });

    expect(broker.list("mapper", "1")).toEqual([
      expect.objectContaining({
        agent_id: "agent:mapper",
        sequence: 3,
        type: "agent.turn.completed",
        version: "spawnfile.activity.v1",
        wake_id: "wake-2",
        wake_kind: "schedule"
      })
    ]);
    expect(broker.list("Reviewer", "10")).toEqual([
      expect.objectContaining({
        agent_slug: "reviewer",
        sequence: 2,
        wake_kind: "message"
      })
    ]);
    expect(typeof broker.list(null, null)[0]?.created_at).toBe("string");
  });

  it("redacts token-like values and host paths from activity errors", () => {
    const { formatActivityError } = loadHarness();

    const redacted = formatActivityError(
      'failed Bearer abcdefghijklmnop sk-proj-abcdefghijklmnopqrstuvwxyz /Users/apresmoi/.codex/auth.json {"refresh_token":"super-secret"}'
    );

    expect(redacted).toContain("Bearer [REDACTED]");
    expect(redacted).toContain("[path]");
    expect(redacted).not.toContain("abcdefghijklmnop");
    expect(redacted).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain("/Users/apresmoi");
    expect(redacted).not.toContain("super-secret");
  });
});
