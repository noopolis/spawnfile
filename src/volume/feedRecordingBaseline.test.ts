import * as fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { publishFeedLanded } from "./feedLandings.js";
import { readFeedLanded, type FeedLandedRecord } from "./feedRecord.js";
import { refreshVolumeFeed } from "./feedRefresh.js";
import { createFeedFixture, writeSourceFiles, type FeedFixture } from "./feedTestKit.js";

vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }));
let fixture: FeedFixture;
afterEach(() => { vi.restoreAllMocks(); fixture?.cleanup(); });
const clock = { now: () => new Date("2026-10-01T08:00:00.123Z") };

it("publishes record-off bytes and filesystem calls identically to the origin/main writer", () => {
  fixture = createFeedFixture();
  refreshVolumeFeed(fixture.target, clock);
  const record = readFeedLanded(fixture.target.stateDir).record!;
  const file = path.join(fixture.target.stateDir, "landed.json");
  // Baseline: origin/main feedRecord.ts writeFeedLanded, before recording was added.
  const originalWrite = (value: FeedLandedRecord): void => {
    fs.mkdirSync(fixture.target.stateDir, { mode: 0o700, recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const calls = ["mkdirSync", "readFileSync", "rmSync", "writeFileSync", "renameSync", "openSync", "closeSync", "fsyncSync", "writeSync"] as const;
  const spies = calls.map((name) => ({ name, spy: vi.spyOn(fs, name) }));
  const trace = () => spies.flatMap(({ name, spy }) => spy.mock.calls.map((args, index) => ({ name, args, order: spy.mock.invocationCallOrder[index]! })))
    .sort((left, right) => left.order - right.order).map(({ name, args }) => ({ name, args }));
  originalWrite(record);
  const expectedCalls = trace(), expectedBytes = fs.readFileSync(file, "utf8");
  vi.clearAllMocks();
  publishFeedLanded(fixture.target, record, clock.now(), record);
  expect(trace()).toEqual(expectedCalls);
  expect(fs.readFileSync(file, "utf8")).toBe(expectedBytes);
  expect(record.identity.landed_at).toBe("2026-10-01T08:00:00Z");
  expect(record).not.toHaveProperty("recording");
});

it("performs only the original predecessor read and no fsyncs throughout record-off refreshes", () => {
  fixture = createFeedFixture();
  const read = vi.spyOn(fs, "readFileSync"), sync = vi.spyOn(fs, "fsyncSync");
  const landed = path.join(fixture.target.stateDir, "landed.json");
  for (const content of ["first\n", "second\n", "third\n"]) {
    writeSourceFiles(fixture.source, { "a.txt": content });
    vi.clearAllMocks();
    expect(refreshVolumeFeed(fixture.target, clock).status).toBe("landed");
    expect(read.mock.calls.filter(([file]) => file === landed)).toHaveLength(1);
    expect(sync).not.toHaveBeenCalled();
  }
});
