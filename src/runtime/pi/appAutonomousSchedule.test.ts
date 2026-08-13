import { afterEach, describe, expect, it, vi } from "vitest";

import { renderPiScheduleSource } from "./appScheduleSource.js";

interface ScheduledAgent {
  readonly config: {
    readonly id: string;
    readonly schedule: { readonly every: string; readonly kind: "every"; readonly prompt: string };
    readonly surfaces: { readonly moltnet: { readonly wake: "never" } };
  };
  readonly paths: { readonly workspacePath: string };
  readonly wake: (event: Record<string, unknown>) => Promise<void>;
}

const loadScheduleInstaller = async (): Promise<((
  agents: readonly ScheduledAgent[],
  timers: unknown[],
  runOnce: boolean,
) => Promise<number>)> => {
  const encoded = Buffer.from(renderPiScheduleSource()).toString("base64");
  const runtime = await import(`data:text/javascript;base64,${encoded}`) as {
    installAgentSchedules: (
      agents: readonly ScheduledAgent[],
      timers: unknown[],
      runOnce: boolean,
    ) => Promise<number>;
  };
  return runtime.installAgentSchedules;
};

afterEach(() => vi.useRealTimers());

describe("generated Pi autonomous schedules", () => {
  it("keeps four wake-never members claiming, observing, and acting without acknowledgement", async () => {
    vi.useFakeTimers();
    const operations: Array<{ readonly agent: string; readonly operation: string; readonly wake: string }> = [];
    const members = ["alpha", "beta", "gamma", "delta"] as const;
    const agents: ScheduledAgent[] = members.map((member) => ({
      config: {
        id: `agent:${member}`,
        schedule: {
          every: "10s",
          kind: "every",
          prompt: `Choose ${member}'s strategy.`,
        },
        surfaces: { moltnet: { wake: "never" } },
      },
      paths: { workspacePath: `/workspace/${member}` },
      wake: async (event) => {
        expect(event).toMatchObject({ from: "scheduler", kind: "schedule" });
        expect(event).not.toHaveProperty("delivery");
        const wake = String(event.id);
        operations.push({ agent: member, operation: "world_claim", wake });
        operations.push({ agent: member, operation: "world_observe", wake });
        operations.push({ agent: member, operation: "world_act", wake });
        // No world acknowledgement is returned; scheduling remains timer-owned.
      },
    }));
    const timers: unknown[] = [];

    const installAgentSchedules = await loadScheduleInstaller();
    expect(await installAgentSchedules(agents, timers, false)).toBe(4);
    expect(timers).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(20_100);

    for (const member of members) {
      const memberOperations = operations.filter(({ agent }) => agent === member);
      expect(memberOperations.filter(({ operation }) => operation === "world_claim")).toHaveLength(3);
      expect(memberOperations.filter(({ operation }) => operation === "world_observe")).toHaveLength(3);
      expect(memberOperations.filter(({ operation }) => operation === "world_act")).toHaveLength(3);
      expect(new Set(memberOperations.map(({ wake }) => wake)).size).toBe(3);
    }
    expect(operations.some(({ operation }) => operation === "send_nudge")).toBe(false);
  });
});
