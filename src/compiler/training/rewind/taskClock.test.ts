import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskClock, taskClockEnvironment } from "./taskClock.js";

afterEach(() => vi.restoreAllMocks());

describe("training task clock contract", () => {
  it("normalizes the bundle origin and returns exact cross-repository environment values", () => {
    const origin = "2026-10-09T10:20:31.120000000+02:00", anchor = 1_790_000_000_123;
    expect(createTaskClock(origin)).toEqual({ version: "spawnfile.task-clock.v1", origin: "2026-10-09T08:20:31.12Z" });
    expect(taskClockEnvironment(origin, anchor)).toEqual({
      NOOPOLIS_TASK_CLOCK: '{"version":"noopolis.task-clock.v1","origin":"2026-10-09T08:20:31.12Z","anchorEpochMs":1790000000123}',
      MNEME_CLOCK_ORIGIN: "2026-10-09T08:20:31.12Z", MNEME_CLOCK_ANCHOR_MS: "1790000000123",
      FAKETIME: "@2026-10-09 08:20:31", FAKETIME_DONT_FAKE_MONOTONIC: "1"
    });
  });

  it("uses only its supplied anchor without wall-clock reads, sleeping, or process environment mutation", () => {
    const environment = { ...process.env };
    const now = vi.spyOn(Date, "now").mockImplementation(() => { throw Error("read live clock"); });
    const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(() => { throw Error("started timeout"); });
    const interval = vi.spyOn(globalThis, "setInterval").mockImplementation(() => { throw Error("started interval"); });
    const first = taskClockEnvironment("2026-10-09T08:20:31Z", 0);
    expect(taskClockEnvironment("2026-10-09T10:20:31+02:00", 0)).toEqual(first);
    expect(JSON.parse(first.NOOPOLIS_TASK_CLOCK!).anchorEpochMs).toBe(0);
    expect(now).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled(); expect(interval).not.toHaveBeenCalled();
    expect(process.env).toEqual(environment);
  });

  it.each([NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("refuses non-integer or unsafe anchor %s", (anchor) => {
    expect(() => taskClockEnvironment("2026-10-09T08:20:31Z", anchor)).toThrow(/anchorEpochMs must be a safe integer/u);
  });
});
