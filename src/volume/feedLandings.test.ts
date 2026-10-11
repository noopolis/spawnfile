import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { feedLandingAt, readFeedLandings } from "./index.js";
import { readFeedLanded } from "./feedRecord.js";
import { refreshVolumeFeed } from "./feedRefresh.js";
import { createFeedFixture, writeSourceFiles, type FeedFixture } from "./feedTestKit.js";

vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }));
let fixture: FeedFixture;
afterEach(() => { vi.restoreAllMocks(); fixture?.cleanup(); });
const day = 86_400_000;
const at = (date: number) => ({ now: () => new Date(`2026-10-${String(date).padStart(2, "0")}T08:00:00.123Z`) });
const entries = () => readFeedLandings(fixture.target.stateDir).entries;
const logFile = () => path.join(fixture.target.stateDir, "landings.jsonl");
const git = (...args: string[]) => execFileSync("git", ["-C", fixture.source, "-c", "user.name=feed", "-c", "user.email=feed@example.test", ...args], { encoding: "utf8" }).trim();

describe("feed landing history", () => {
  it("records land, generation re-land and retained-tree re-point with the host identity instant", () => {
    fixture = createFeedFixture({ keep: 2, record: { keepMs: 30 * day } });
    refreshVolumeFeed(fixture.target, at(1));
    const first = entries()[0]!;
    expect(first).toEqual({ version: "spawnfile.volume-feed-landing.v1", resource: "shared-data", volume: "shared-data-vol",
      revision: readFeedLanded(fixture.target.stateDir).record!.revision, tree: readFeedLanded(fixture.target.stateDir).record!.identity.tree,
      source: { kind: "directory", directory: fixture.source }, landed_at: at(1).now().toISOString() });
    const file = path.join(fixture.volume, first.tree, "a.txt");
    fs.chmodSync(file, 0o644); fs.writeFileSync(file, "ALPHA\n");
    expect(refreshVolumeFeed(fixture.target, at(2)).status).toBe("repaired");
    expect(entries()[1]).toMatchObject({ revision: first.revision, tree: `${first.tree}.1`, landed_at: at(2).now().toISOString() });
    writeSourceFiles(fixture.source, { "a.txt": "beta\n" });
    refreshVolumeFeed(fixture.target, at(3));
    writeSourceFiles(fixture.source, { "a.txt": "alpha\n" });
    refreshVolumeFeed(fixture.target, at(4));
    expect(entries()).toHaveLength(4);
    expect(entries()[3]).toMatchObject({ revision: first.revision, tree: `${first.tree}.1`, landed_at: at(4).now().toISOString() });
    expect(entries()[3]!.landed_at).toBe(readFeedLanded(fixture.target.stateDir).record!.identity.landed_at);
    refreshVolumeFeed(fixture.target, at(5));
    expect(entries()).toHaveLength(4);
  });

  it("does not touch a landing log when record is off, including an existing corrupt log", () => {
    fixture = createFeedFixture();
    refreshVolumeFeed(fixture.target, at(1));
    expect(fs.existsSync(logFile())).toBe(false);
    fs.writeFileSync(logFile(), "do not read or change\n");
    const read = vi.spyOn(fs, "readFileSync"), open = vi.spyOn(fs, "openSync");
    writeSourceFiles(fixture.source, { "a.txt": "beta\n" });
    refreshVolumeFeed(fixture.target, at(2));
    expect(read.mock.calls.some(([file]) => file === logFile())).toBe(false);
    expect(open.mock.calls.some(([file]) => file === logFile())).toBe(false);
    expect(fs.readFileSync(logFile(), "utf8")).toBe("do not read or change\n");
  });

  it("never appends when publishing landed.json fails", () => {
    fixture = createFeedFixture({ record: { keepMs: day } });
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === path.join(fixture.target.stateDir, "landed.json")) throw new Error("landed write failed");
      rename(from, to);
    });
    expect(() => refreshVolumeFeed(fixture.target, at(1))).toThrow("landed write failed");
    expect(fs.existsSync(logFile())).toBe(false);
  });

  it("starts recording an already landed clean feed without waiting for new content", () => {
    fixture = createFeedFixture();
    refreshVolumeFeed(fixture.target, at(1));
    const identity = readFeedLanded(fixture.target.stateDir).record!.identity;
    fixture.target.record = { keepMs: 30 * day };
    expect(refreshVolumeFeed(fixture.target, at(2)).status).toBe("current");
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ revision: identity.revision, tree: identity.tree, landed_at: identity.landed_at });
    refreshVolumeFeed(fixture.target, at(3));
    expect(entries()).toHaveLength(1);
  });

  it("recovers a missing append from the committed host record on a clean refresh", () => {
    fixture = createFeedFixture({ record: { keepMs: 30 * day } });
    const open = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((file, ...args) => {
      if (file === logFile()) throw new Error("append failed");
      return open(file, ...args);
    });
    expect(() => refreshVolumeFeed(fixture.target, at(1))).toThrow("append failed");
    const identity = readFeedLanded(fixture.target.stateDir).record!.identity;
    vi.restoreAllMocks();
    expect(refreshVolumeFeed(fixture.target, at(2)).status).toBe("current");
    expect(entries()).toHaveLength(1);
    expect(entries()[0]!.landed_at).toBe(identity.landed_at);
  });

  it("retains the newest before cutoff even after its physical tree is retired", () => {
    fixture = createFeedFixture({ keep: 0, record: { keepMs: 2 * day } });
    for (const date of [1, 2, 3, 10]) {
      writeSourceFiles(fixture.source, { "a.txt": String(date) });
      refreshVolumeFeed(fixture.target, at(date));
    }
    expect(entries().map((entry) => entry.landed_at)).toEqual([at(3).now().toISOString(), at(10).now().toISOString()]);
    expect(fs.existsSync(path.join(fixture.volume, entries()[0]!.tree))).toBe(false);
    expect(fs.statSync(logFile()).mode & 0o777).toBe(0o600);
    expect(feedLandingAt(entries(), at(8).now())).toEqual(entries()[0]);
    expect(feedLandingAt(entries(), at(10).now())).toEqual(entries()[1]);
    expect(feedLandingAt(entries(), new Date(at(3).now().getTime() - 1))).toBeNull();
  });

  it("records resolved git provenance, expanded paths/ref, period adoption and link repairs", () => {
    fixture = createFeedFixture({ freeze: { after: "23:59", timezone: "UTC" } });
    fs.mkdirSync(path.join(fixture.source, "published"));
    fs.writeFileSync(path.join(fixture.source, "published", "data"), "news\n");
    git("init", "-q", "-b", "main"); git("add", "."); git("commit", "-qm", "feed");
    const commit = git("rev-parse", "HEAD");
    for (const date of ["01", "02"]) git("branch", `data/2026-10-${date}`);
    fixture.target.source = { kind: "git", repo: fixture.source, ref: "HEAD", paths: ["published"], fetch: false };
    fixture.target.refRule = { template: "data/${date}" };
    refreshVolumeFeed(fixture.target, at(1));
    fixture.target.record = { keepMs: 30 * day };
    expect(refreshVolumeFeed(fixture.target, { now: () => new Date("2026-10-01T23:59:30.000Z") }).status).toBe("frozen");
    expect(entries()[0]).toMatchObject({ commit, ref: "data/2026-10-01", paths: ["published"], period: "2026-10-01", source: { kind: "git", repo: fixture.source } });
    expect(refreshVolumeFeed(fixture.target, at(2)).status).toBe("current");
    expect(entries()[1]).toMatchObject({ commit, ref: "data/2026-10-02", period: "2026-10-02", landed_at: at(2).now().toISOString() });
    fs.unlinkSync(path.join(fixture.volume, "current"));
    refreshVolumeFeed(fixture.target, { now: () => new Date("2026-10-02T09:00:00.456Z") });
    expect(entries()[2]).toMatchObject({ commit, landed_at: "2026-10-02T09:00:00.456Z" });
    expect(feedLandingAt(entries(), entries()[0]!.landed_at)).toEqual(entries()[0]);
    fs.appendFileSync(logFile(), "broken\n{}\n");
    expect(readFeedLandings(fixture.target.stateDir).errors).toEqual(["line 4: invalid JSON or entry", "line 5: invalid JSON or entry"]);
  });
});
