import { afterEach, describe, expect, it, vi } from "vitest";
import { clockAwareEnvironment, createTaskClock, harnessTaskClockEnvironment, processClockEnvironment } from "./taskClock.js";

afterEach(() => vi.restoreAllMocks());
const helpers = [harnessTaskClockEnvironment, processClockEnvironment, clockAwareEnvironment];
// Shared Spawnfile/Daimon contract vectors, also documented in specs/TRAINING.md.
const vectors: Array<[string, number, string]> = [
  ["2001-01-01T00:00:00.000Z", 1_821_692_800_250, "-843385600.250"],
  ["2001-01-01T00:00:00.000Z", 1_821_692_860_250, "-843385660.250"],
  ["2001-01-01T00:00:00.250Z", 978_307_200_000, "+0.250"],
  ["2001-01-01T00:00:00.000Z", 978_307_200_001, "-0.001"],
  ["2001-01-01T00:00:00.000Z", 978_307_200_000, "+0"],
  ["2001-01-01T00:00:00.000Z", 978_307_199_000, "+1"]
];

describe("training task clock contract", () => {
  it.each(["1969-12-31T23:59:59.999999999Z", "1970-01-01T00:00:00+00:01", "9999-12-31T23:59:59.999000001Z", "9999-12-31T23:59:59-00:01"])
    ("refuses the out-of-range trial instant %s in every helper", (origin) => {
      expect(() => createTaskClock(origin)).toThrow(/must be within 1970.*9999/u);
      for (const helper of helpers) expect(() => helper(origin, 0)).toThrow(/must be within 1970.*9999/u);
    });

  it.each(["1970-01-01T00:00:00Z", "1969-12-31T23:00:00-01:00", "9999-12-31T23:59:59.999Z"])
    ("accepts the inclusive trial boundary %s", (origin) => {
      expect(() => createTaskClock(origin)).not.toThrow();
      for (const helper of helpers) expect(() => helper(origin, 0)).not.toThrow();
    });
  it("normalizes the origin and gives each process exactly one clock owner", () => {
    const origin = "2026-10-09T10:20:31.120000000+02:00", anchor = 1_790_000_000_123;
    expect(createTaskClock(origin)).toEqual({ version: "spawnfile.task-clock.v1", origin: "2026-10-09T08:20:31.12Z" });
    expect(harnessTaskClockEnvironment(origin, anchor)).toEqual({
      NOOPOLIS_TASK_CLOCK: '{"version":"noopolis.task-clock.v1","origin":"2026-10-09T08:20:31.12Z","anchorEpochMs":1790000000123}'
    });
    expect(clockAwareEnvironment(origin, anchor)).toEqual({
      MNEME_CLOCK_ORIGIN: "2026-10-09T08:20:31.12Z", MNEME_CLOCK_ANCHOR_MS: "1790000000123"
    });
    expect(Object.keys(processClockEnvironment(origin, anchor)).sort()).toEqual(["FAKETIME", "FAKETIME_DONT_FAKE_MONOTONIC"]);
    for (const helper of helpers) {
      const env = helper(origin, anchor);
      expect(["NOOPOLIS_TASK_CLOCK", "MNEME_CLOCK_ORIGIN", "FAKETIME"].filter((key) => key in env)).toHaveLength(1);
    }
  });

  it.each(vectors)("matches the shared offset for %s anchored at %s", (origin, anchor, expected) => {
    const processEnv = processClockEnvironment(origin, anchor);
    expect(processEnv).toEqual({ FAKETIME: expected, FAKETIME_DONT_FAKE_MONOTONIC: "1" });
    const contract = JSON.parse(harnessTaskClockEnvironment(origin, anchor).NOOPOLIS_TASK_CLOCK!);
    const aware = clockAwareEnvironment(origin, anchor);
    // Daimon's task-clock formula, including a later independently started process.
    for (const delay of [0, 1, 60_123]) {
      const realNow = anchor + delay;
      const daimonNow = Date.parse(contract.origin) + (realNow - contract.anchorEpochMs);
      expect(realNow + Number(processEnv.FAKETIME) * 1000).toBe(daimonNow);
      expect(Date.parse(aware.MNEME_CLOCK_ORIGIN!) + realNow - Number(aware.MNEME_CLOCK_ANCHOR_MS)).toBe(daimonNow);
      expect(daimonNow).toBe(Date.parse(origin) + delay);
    }
  });

  it("changes the relative offset when the shared anchor changes", () => {
    const origin = "2001-01-01T00:00:00.000Z";
    expect(processClockEnvironment(origin, 1_821_692_800_250).FAKETIME).toBe("-843385600.250");
    expect(processClockEnvironment(origin, 1_821_692_860_250).FAKETIME).toBe("-843385660.250");
  });

  it("uses only its supplied anchor without wall-clock reads, sleeping, or process environment mutation", () => {
    const environment = { ...process.env };
    const now = vi.spyOn(Date, "now").mockImplementation(() => { throw Error("read live clock"); });
    const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(() => { throw Error("started timeout"); });
    const interval = vi.spyOn(globalThis, "setInterval").mockImplementation(() => { throw Error("started interval"); });
    for (const helper of helpers) {
      expect(helper("2026-10-09T08:20:31Z", 0)).toEqual(helper("2026-10-09T10:20:31+02:00", 0));
    }
    expect(now).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled(); expect(interval).not.toHaveBeenCalled();
    expect(process.env).toEqual(environment);
  });

  it.each([NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("refuses non-integer or unsafe anchor %s", (anchor) => {
    for (const helper of helpers) expect(() => helper("2026-10-09T08:20:31Z", anchor)).toThrow(/anchorEpochMs must be a safe integer/u);
  });
});
