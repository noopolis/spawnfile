import * as fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { feedLandingAt, isFeedLanding, readFeedLandings } from "./feedLandings.js";
import { LINK_OPS, type LinkOps } from "./feedLayout.js";
import { readFeedLanded } from "./feedRecord.js";
import { refreshVolumeFeed } from "./feedRefresh.js";
import { createFeedFixture, writeSourceFiles, type FeedFixture } from "./feedTestKit.js";

let fixture: FeedFixture;
afterEach(() => { vi.restoreAllMocks(); fixture?.cleanup(); });
const start = new Date("2026-10-01T08:00:00.000Z").getTime();
const instant = (ms: number) => new Date(start + ms);

describe("feed switching interval", () => {
  it.each(["advance", "repair"])("samples immediately before the current rename on %s", (mode) => {
    fixture = createFeedFixture({ record: { keepMs: 86_400_000 } });
    refreshVolumeFeed(fixture.target, { now: () => instant(0) });
    const first = readFeedLandings(fixture.target.stateDir).entries[0]!;
    if (mode === "advance") writeSourceFiles(fixture.source, { "a.txt": "B\n" });
    else fs.unlinkSync(path.join(fixture.volume, "current"));
    let time = 100;
    const events: string[] = [];
    const ops: LinkOps = {
      ...LINK_OPS,
      symlink: (to, file) => { events.push("symlink"); time = 200; LINK_OPS.symlink(to, file); },
      rename: (from, to) => {
        expect(events.at(-1)).toBe("clock:200");
        events.push("rename");
        // A wake at .201 may see either link target while rename is in flight.
        time = 202;
        LINK_OPS.rename(from, to);
      }
    };
    refreshVolumeFeed(fixture.target, { ops, now: () => { events.push(`clock:${time}`); return instant(time); } });
    const entries = readFeedLandings(fixture.target.stateDir).entries;
    const landed = entries.at(-1)!;
    expect(landed).toMatchObject({ switching_at: instant(200).toISOString(), landed_at: instant(202).toISOString() });
    expect(landed.landed_at).toBe(readFeedLanded(fixture.target.stateDir).record!.identity.landed_at);
    expect(feedLandingAt(entries, instant(199))).toEqual(first);
    for (const ms of [200, 201, 202]) expect(feedLandingAt(entries, instant(ms))).toEqual({ ...landed, ambiguous: true });
    expect(feedLandingAt(entries, instant(203))).toEqual(landed);
    expect(feedLandingAt(entries, instant(-1))).toBeNull();
    expect(() => feedLandingAt(entries, "invalid")).toThrow("valid instant");
    expect(isFeedLanding({ ...landed, switching_at: instant(203).toISOString() })).toBe(false);
    expect(isFeedLanding({ ...landed, switching_at: "invalid" })).toBe(false);
  });
});
