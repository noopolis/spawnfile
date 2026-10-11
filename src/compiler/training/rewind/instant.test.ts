import { describe, expect, it } from "vitest";
import { compareInstants, instantNanos, normalizeInstant } from "./instant.js";

describe("rewind instant comparisons", () => {
  it("compares RFC3339Nano fractions numerically when string order is reversed", () => {
    const earlier = "2026-10-09T08:20:31.1Z", later = "2026-10-09T08:20:31.11Z";
    expect(earlier > later).toBe(true);
    expect(compareInstants(earlier, later)).toBe(-1);
    expect(compareInstants(later, earlier)).toBe(1);
    expect(compareInstants("2026-10-09T08:20:31.100000000Z", earlier)).toBe(0);
  });

  it("preserves nanosecond boundaries and offset-equivalent instants", () => {
    const before = "2026-10-09T08:20:31.123456789Z", after = "2026-10-09T08:20:31.123456790Z";
    expect(instantNanos(after) - instantNanos(before)).toBe(1n);
    expect(compareInstants(before, "2026-10-09T10:20:31.123456789+02:00")).toBe(0);
    expect(compareInstants(after, before)).toBe(1);
  });

  it.each([
    ["2026-10-09T10:20:31.120000000+02:00", "2026-10-09T08:20:31.12Z"],
    ["2026-10-09T08:20Z", "2026-10-09T08:20:00Z"],
    ["2026-10-09T00:01:00+14:00", "2026-10-08T10:01:00Z"],
    ["1969-12-31T23:59:59.999999999Z", "1969-12-31T23:59:59.999999999Z"]
  ])("normalizes %s to UTC without losing precision", (input, expected) => {
    expect(normalizeInstant(input)).toBe(expected);
    expect(compareInstants(input, expected)).toBe(0);
  });

  it.each(["invalid", "2026-02-30T00:00:00Z", "2026-10-09T08:20:31", "2026-10-09T08:20:31.1234567891Z"])(
    "refuses unsupported or invalid instant %s", (value) => {
      expect(() => instantNanos(value)).toThrow();
    }
  );
});
