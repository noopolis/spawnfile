import { describe, expect, it } from "vitest";
import { feedLandingSchema, selectFeedLanding, type FeedLanding } from "./feedLandings.js";

const AT = "2026-10-09T08:20:31Z", REVISION = "a".repeat(64);
const landing = (fields: Partial<FeedLanding> = {}): FeedLanding => ({
  version: "spawnfile.volume-feed-landing.v1", resource: "news", volume: "org-news", revision: REVISION,
  tree: `trees/${REVISION}.2`, source: { kind: "git", repo: "https://never-fetch.invalid/source" },
  commit: "a".repeat(40), ref: "daily/2026-10-09", paths: ["published"], landed_at: AT, ...fields
});

describe("recording feed landing compatibility", () => {
  it("accepts snake_case recording rows and directory sources without git fields", () => {
    const row = landing({ switching_at: AT, period: "2026-10-09" });
    expect(feedLandingSchema.parse(row)).toEqual(row);
    const { commit: _commit, ref: _ref, paths: _paths, ...directory } = row;
    expect(feedLandingSchema.parse({ ...directory, source: { kind: "directory", directory: "/deployed/news" } })).toMatchObject({
      source: { kind: "directory", directory: "/deployed/news" }
    });
  });

  it("refuses malformed provenance, paths, tree identities and reversed transitions", () => {
    const row = landing();
    for (const invalid of [
      { ...row, landedAt: AT }, { ...row, revision: "b".repeat(64) }, { ...row, tree: `trees/${REVISION}/../escape` },
      { ...row, paths: ["../escape"] }, { ...row, commit: "HEAD" }, { ...row, commit: null },
      { ...row, source: { kind: "git" } }, { ...row, ref: undefined },
      { ...row, switching_at: "2026-10-09T08:20:31.000000001Z" }
    ]) expect(() => feedLandingSchema.parse(invalid)).toThrow();
  });

  it("uses last-appended state for equal instants, including equivalent offsets", () => {
    const first = landing(), last = landing({ tree: `trees/${REVISION}.3`, landed_at: "2026-10-09T10:20:31+02:00" });
    expect(selectFeedLanding([first, last], AT)).toEqual({ landing: last, ambiguous: false });
    expect(selectFeedLanding([last, first], AT)).toEqual({ landing: first, ambiguous: false });
    expect(selectFeedLanding([last, first], "2026-10-09T08:20:30.999999999Z")).toBeNull();
  });

  it.each(["2026-10-09T08:20:30Z", AT, "2026-10-09T08:20:32Z"])
    ("selects the incoming row inside the inclusive transition at %s", (at) => {
      const previous = landing({ landed_at: "2026-10-09T08:00:00Z" });
      const incoming = landing({ switching_at: "2026-10-09T08:20:30Z", landed_at: "2026-10-09T08:20:32Z" });
      expect(selectFeedLanding([previous, incoming], at)).toEqual({ landing: incoming, ambiguous: true });
      expect(selectFeedLanding([previous, incoming], "2026-10-09T08:20:32.000000001Z")).toEqual({ landing: incoming, ambiguous: false });
    });

  it("marks a zero-duration transition ambiguous at the shared boundary", () => {
    const row = landing({ switching_at: AT });
    expect(selectFeedLanding([row], "2026-10-09T10:20:31+02:00")).toEqual({ landing: row, ambiguous: true });
  });
});
