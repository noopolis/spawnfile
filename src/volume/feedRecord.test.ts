import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { feedIdentityFindings, feedLandedFindings, readFeedLanded, writeFeedIdentity, writeFeedLanded, type FeedIdentity, type FeedLandedRecord } from "./feedRecord.js";
import { createFeedFixture, type FeedFixture } from "./feedTestKit.js";

let fixture: FeedFixture;
afterEach(() => fixture?.cleanup());

const revision = "a".repeat(64);
const identity: FeedIdentity = {
  files: 1, landed_at: "2026-01-01T00:00:00Z", resource: "r", revision, source: { kind: "directory" },
  tree: `trees/${revision}`, version: "spawnfile.volume-feed.v1", volume: "v"
};
const record: FeedLandedRecord = { heals: {}, identity, identity_sha256: "b".repeat(64), revision, trees: [revision], version: "spawnfile.volume-feed-landed.v1" };

describe("feed records", () => {
  it("names every way an identity record is wrong", () => {
    expect(feedIdentityFindings(identity)).toEqual([]);
    expect(feedIdentityFindings(null)).toEqual(["must be a JSON object"]);
    expect(feedIdentityFindings([])).toEqual(["must be a JSON object"]);
    expect(feedIdentityFindings({})).toEqual([
      "version must be spawnfile.volume-feed.v1", "revision must be a 64-character hex digest", "resource must name the volume resource",
      "volume must name the host volume", "files must be a count", "landed_at must be an instant", "source must describe a git or directory source"
    ]);
    expect(feedIdentityFindings({ ...identity, tree: "trees/other" })).toEqual([`tree must be trees/${revision}`]);
    expect(feedIdentityFindings({ ...identity, source: { kind: "other" } })).toEqual(["source must describe a git or directory source"]);
  });

  it("names every way a host record is wrong", () => {
    expect(feedLandedFindings(record)).toEqual([]);
    expect(feedLandedFindings("x")).toEqual(["must be a JSON object"]);
    expect(feedLandedFindings({ ...record, trees: ["c".repeat(64)] })).toEqual(["trees must include the serving revision"]);
    expect(feedLandedFindings({ ...record, trees: "x" })).toContain("trees must list landed revisions");
    expect(feedLandedFindings({ ...record, revision: "c".repeat(64), trees: ["c".repeat(64)] })).toEqual(["identity must describe the serving revision"]);
    expect(feedLandedFindings({ ...record, heals: [], identity_sha256: "x", version: "v" })).toEqual([
      "version must be spawnfile.volume-feed-landed.v1", "identity_sha256 must be a hex digest", "heals must be an object"
    ]);
    expect(feedLandedFindings({ ...record, identity: undefined, revision: undefined })).toEqual(expect.arrayContaining(["revision must be a 64-character hex digest", "identity must be a JSON object"]));
  });

  it("degrades an unreadable or invalid host record to nothing landed and refuses to write an invalid one", () => {
    fixture = createFeedFixture();
    const state = fixture.target.stateDir;
    expect(readFeedLanded(state)).toEqual({ reason: null, record: null });
    mkdirSync(state, { recursive: true });
    writeFileSync(path.join(state, "landed.json"), "{");
    expect(readFeedLanded(state).reason).toMatch(/not parseable/u);
    writeFileSync(path.join(state, "landed.json"), "{}");
    expect(readFeedLanded(state).reason).toMatch(/invalid/u);
    expect(() => writeFeedLanded(state, { ...record, trees: [] })).toThrow(/refusing to write an invalid landed\.json/u);
    writeFeedLanded(state, record);
    expect(readFeedLanded(state).record).toEqual(record);
  });

  it("refuses to publish an invalid identity record", () => {
    fixture = createFeedFixture();
    expect(() => writeFeedIdentity(fixture.volume, { ...identity, files: -1 }, { tmpDir: fixture.root })).toThrow(/refusing to publish/u);
  });
});
