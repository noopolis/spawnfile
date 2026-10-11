import { describe, expect, it } from "vitest";

import { DEFAULT_RECORD_KEEP_MS, maxRecordingKeepMs, recordingKeepMs } from "./recording.js";

describe("recording retention", () => {
  it("is off when absent, defaults to thirty days when empty, and uses the longest consumer window", () => {
    expect(recordingKeepMs(undefined)).toBeUndefined();
    expect(recordingKeepMs({})).toBe(30 * 24 * 60 * 60_000);
    expect(maxRecordingKeepMs([undefined, undefined])).toBeUndefined();
    expect(maxRecordingKeepMs([{ keep: "90m" }, { keep: "2h" }])).toBe(2 * 60 * 60_000);
    expect(maxRecordingKeepMs([{}, { keep: "1d" }, undefined])).toBe(DEFAULT_RECORD_KEEP_MS);
    expect(maxRecordingKeepMs([{}, { keep: "60d" }])).toBe(60 * 24 * 60 * 60_000);
  });

  it.each(["0d", "-1d", "01d", "1.5d", "1w", "30D", " 1d", "999999999999999999999d"])(
    "rejects an invalid or unsafe duration %s", (keep) => expect(() => recordingKeepMs({ keep })).toThrow(/record.keep/u)
  );
});
