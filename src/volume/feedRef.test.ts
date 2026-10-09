import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readFeedLanded } from "./feedRecord.js";
import { expandFeedPaths, expandFeedRefTemplate, feedCutoffInstant, feedFrozen, feedLocalClock, feedLocalDate } from "./feedRef.js";
import type { FeedLandedRecord } from "./feedRecord.js";
import type { FeedExec } from "./feedSource.js";
import { hostExec } from "./feedSource.js";
import { feedResultClean, refreshVolumeFeed } from "./feedRefresh.js";
import { createFeedFixture, type FeedFixture } from "./feedTestKit.js";

let fixture: FeedFixture;
afterEach(() => fixture?.cleanup());

const git = (repo: string, ...args: string[]): string =>
  execFileSync("git", ["-C", repo, "-c", "user.email=feed@example.test", "-c", "user.name=feed", ...args], { encoding: "utf8" }).trim();

/** Commits `files` on `branch` (created from main when new) and returns to main. */
const commitOn = (repo: string, branch: string, files: Record<string, string>): string => {
  const exists = (() => { try { git(repo, "rev-parse", "--verify", "--quiet", branch); return true; } catch { return false; } })();
  git(repo, "checkout", "-q", ...(exists ? [branch] : ["-b", branch, "main"]));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    writeFileSync(path.join(repo, name), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--allow-empty", "-m", branch);
  const commit = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  return commit;
};

// 2026-10-09 in Europe/Berlin is UTC+2: 09:00Z is 11:00 local, 10:30Z is 12:30 local.
const at = (iso: string): { now: () => Date } => ({ now: () => new Date(iso) });
const FREEZE = { after: "12:00", timezone: "Europe/Berlin" };

const datedFixture = (): string => {
  fixture = createFeedFixture();
  const repo = path.join(fixture.root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  fixture.target.source = { fetch: false, kind: "git", ref: "HEAD", repo };
  fixture.target.refRule = { template: "data/${date:Europe/Berlin}" };
  fixture.target.freeze = FREEZE;
  return repo;
};

const served = (name: string): string => readFileSync(path.join(fixture.volume, "current", name), "utf8");
const link = (): string => readlinkSync(path.join(fixture.volume, "current"));

describe("feed clock and templates", () => {
  it("expands the date placeholder in the declared zone, and UTC without one", () => {
    const instant = new Date("2026-10-09T22:30:00Z");
    expect(expandFeedRefTemplate("data/${date:Europe/Berlin}", instant)).toBe("data/2026-10-10");
    expect(expandFeedRefTemplate("data/${date}", instant)).toBe("data/2026-10-09");
    expect(expandFeedRefTemplate("${date:America/Los_Angeles}/${date}", instant)).toBe("2026-10-09/2026-10-09");
    expect(feedLocalDate(instant, "Asia/Tokyo")).toBe("2026-10-10");
    expect(feedLocalClock(new Date("2026-10-09T00:05:00Z"), "UTC")).toBe("00:05");
  });

  it("resolves the cutoff to an instant, so the repeated hour when clocks fall back never thaws a freeze", () => {
    expect(feedCutoffInstant("2026-10-09", "12:00", "Europe/Berlin").toISOString()).toBe("2026-10-09T10:00:00.000Z");
    expect(feedCutoffInstant("2026-01-15", "12:00", "Europe/Berlin").toISOString()).toBe("2026-01-15T11:00:00.000Z");
    // 2026-10-25: Berlin falls back at 03:00 CEST -> 02:00 CET, so 02:45 local happens before 02:15 local.
    const target = { freeze: { after: "02:30", timezone: "Europe/Berlin" }, source: { kind: "git", ref: "main", repo: "/r", fetch: false } } as never;
    const record = { identity: { source: { kind: "git", ref: "main" } }, period: "2026-10-25" } as unknown as FeedLandedRecord;
    expect(feedCutoffInstant("2026-10-25", "02:30", "Europe/Berlin").toISOString()).toBe("2026-10-25T00:30:00.000Z");
    // 2026-03-29: 02:30 does not exist in Berlin; the earlier candidate is chosen.
    expect(feedCutoffInstant("2026-03-29", "02:30", "Europe/Berlin").toISOString()).toBe("2026-03-29T00:30:00.000Z");
    expect(feedFrozen(target, record, "main", new Date("2026-10-25T00:45:00Z"))).toBe(true);
    expect(feedFrozen(target, record, "main", new Date("2026-10-25T01:15:00Z"))).toBe(true);
    expect(feedFrozen(target, record, "main", new Date("2026-10-24T23:59:00Z"))).toBe(false);
  });
});

describe("moving refs and the daily freeze", () => {
  it("follows today's ref as it fills, freezes at the cutoff, holds until the next period's ref appears, then advances", () => {
    const repo = datedFixture();
    commitOn(repo, "data/2026-10-09", { "day.txt": "09 early\n" });
    const first = refreshVolumeFeed(fixture.target, at("2026-10-09T07:00:00Z"));
    expect(first.status).toBe("landed");
    expect(served("day.txt")).toBe("09 early\n");
    expect(readFeedLanded(fixture.target.stateDir).record).toMatchObject({ identity: { source: { ref: "data/2026-10-09" } }, period: "2026-10-09" });
    // Before the cutoff the volume keeps following the day's ref.
    commitOn(repo, "data/2026-10-09", { "day.txt": "09 late\n" });
    expect(refreshVolumeFeed(fixture.target, at("2026-10-09T09:59:00Z")).status).toBe("landed");
    expect(served("day.txt")).toBe("09 late\n");
    // Past the cutoff a newer commit on the same ref does not move the volume.
    const servedLink = link();
    commitOn(repo, "data/2026-10-09", { "day.txt": "09 after cutoff\n" });
    const frozen = refreshVolumeFeed(fixture.target, at("2026-10-09T10:30:00Z"));
    expect(frozen.status).toBe("frozen");
    expect(feedResultClean(frozen)).toBe(true);
    expect(served("day.txt")).toBe("09 late\n");
    expect(link()).toBe(servedLink);
    // Next morning, before the next period's ref exists: a clean wait, still serving yesterday's content.
    const waiting = refreshVolumeFeed(fixture.target, at("2026-10-09T23:30:00Z"));
    expect(waiting.status).toBe("waiting");
    expect(feedResultClean(waiting)).toBe(true);
    expect(served("day.txt")).toBe("09 late\n");
    // The next period's ref appears: the volume advances.
    commitOn(repo, "data/2026-10-10", { "day.txt": "10 early\n" });
    expect(refreshVolumeFeed(fixture.target, at("2026-10-10T05:00:00Z")).status).toBe("landed");
    expect(served("day.txt")).toBe("10 early\n");
    expect(readFeedLanded(fixture.target.stateDir).record?.period).toBe("2026-10-10");
  });

  it("refuses after the cutoff when the period's ref never appeared, and waits with nothing landed before it", () => {
    datedFixture();
    expect(refreshVolumeFeed(fixture.target, at("2026-10-09T05:00:00Z"))).toMatchObject({ revision: null, status: "waiting" });
    expect(existsSync(path.join(fixture.volume, "current"))).toBe(false);
    expect(() => refreshVolumeFeed(fixture.target, at("2026-10-09T10:01:00Z"))).toThrow(/"data\/2026-10-09" does not exist in .* and the 12:00 Europe\/Berlin cutoff has passed/u);
    fixture.target.freeze = undefined;
    expect(() => refreshVolumeFeed(fixture.target, at("2026-10-09T05:00:00Z"))).toThrow(/"data\/2026-10-09" does not exist/u);
  });

  it("lands the fallback while the templated ref does not exist", () => {
    const repo = datedFixture();
    fixture.target.refRule = { fallback: "main", template: "data/${date:Europe/Berlin}" };
    expect(refreshVolumeFeed(fixture.target, at("2026-10-09T05:00:00Z")).status).toBe("landed");
    expect(served("README.md")).toBe("base\n");
    expect(readFeedLanded(fixture.target.stateDir).record?.identity.source).toMatchObject({ kind: "git", ref: "main" });
    commitOn(repo, "data/2026-10-09", { "day.txt": "09\n" });
    expect(refreshVolumeFeed(fixture.target, at("2026-10-09T06:00:00Z")).status).toBe("landed");
    expect(served("day.txt")).toBe("09\n");
  });

  it("lands the ref a declared command prints", () => {
    const repo = datedFixture();
    fixture.target.freeze = undefined;
    commitOn(repo, "picked", { "picked.txt": "yes\n" });
    const script = path.join(fixture.root, "pick.sh");
    writeFileSync(script, '#!/bin/sh\ntest -n "$SPAWNFILE_FEED_REPO" || exit 9\necho\necho "  picked  "\n', { mode: 0o755 });
    fixture.target.refRule = { command: { argv: [script], cwd: fixture.root, timeoutMs: 5000 } };
    expect(refreshVolumeFeed(fixture.target).status).toBe("landed");
    expect(served("picked.txt")).toBe("yes\n");
    writeFileSync(script, "#!/bin/sh\necho broken >&2\nexit 3\n");
    expect(() => refreshVolumeFeed(fixture.target)).toThrow(/ref command for shared-data failed \(exit 3\): broken/u);
    writeFileSync(script, "#!/bin/sh\nexit 0\n");
    expect(() => refreshVolumeFeed(fixture.target)).toThrow(/the ref command printed no ref does not exist/u);
    fixture.target.refRule = { command: { argv: ["sleep", "5"], cwd: fixture.root, timeoutMs: 100 } };
    expect(() => refreshVolumeFeed(fixture.target)).toThrow(/did not finish within 0s/u);
    fixture.target.refRule = { command: { argv: [path.join(fixture.root, "absent")], cwd: fixture.root, timeoutMs: 1000 } };
    expect(() => refreshVolumeFeed(fixture.target)).toThrow(/could not run/u);
  });

  it("heals a frozen volume from the commit it serves, never from where the ref moved", () => {
    const repo = datedFixture();
    commitOn(repo, "data/2026-10-09", { "day.txt": "09 frozen\n" });
    refreshVolumeFeed(fixture.target, at("2026-10-09T08:00:00Z"));
    commitOn(repo, "data/2026-10-09", { "day.txt": "09 moved!\n" });
    const file = path.join(fixture.volume, link(), "day.txt");
    chmodSync(path.dirname(file), 0o755);
    chmodSync(file, 0o644);
    writeFileSync(file, "09 TAMPER\n");
    expect(refreshVolumeFeed(fixture.target, at("2026-10-09T11:00:00Z")).status).toBe("repaired");
    expect(served("day.txt")).toBe("09 frozen\n");
    expect(readFeedLanded(fixture.target.stateDir).record).toMatchObject({ identity: { source: { ref: "data/2026-10-09" } }, period: "2026-10-09" });
    expect(refreshVolumeFeed(fixture.target, at("2026-10-09T11:05:00Z")).status).toBe("frozen");
  });

  it("re-stamps the period when the ref moves to identical content, so the freeze still holds that day", () => {
    const repo = datedFixture();
    fixture.target.refRule = { template: "data/${date:Europe/Berlin}" };
    commitOn(repo, "data/2026-10-09", { "day.txt": "same\n" });
    refreshVolumeFeed(fixture.target, at("2026-10-09T08:00:00Z"));
    // The next day's ref carries identical content: nothing lands, but the record now belongs to the 10th.
    git(repo, "branch", "data/2026-10-10", "data/2026-10-09");
    expect(refreshVolumeFeed(fixture.target, at("2026-10-10T08:00:00Z")).status).toBe("current");
    expect(readFeedLanded(fixture.target.stateDir).record).toMatchObject({ identity: { source: { ref: "data/2026-10-10" } }, period: "2026-10-10" });
    const identity = JSON.parse(readFileSync(path.join(fixture.volume, ".spawnfile-feed.json"), "utf8"));
    expect(identity.source.ref).toBe("data/2026-10-10");
    commitOn(repo, "data/2026-10-10", { "day.txt": "after cutoff\n" });
    expect(refreshVolumeFeed(fixture.target, at("2026-10-10T10:30:00Z")).status).toBe("frozen");
    expect(served("day.txt")).toBe("same\n");
  });

  it("a repair of this period's content stamps this period, so the freeze still holds after it", () => {
    fixture = createFeedFixture({ freeze: FREEZE });
    refreshVolumeFeed(fixture.target, at("2026-10-09T08:00:00Z"));
    const file = path.join(fixture.volume, link(), "a.txt");
    chmodSync(path.dirname(file), 0o755);
    chmodSync(file, 0o644);
    writeFileSync(file, "ALPHA\n");
    expect(refreshVolumeFeed(fixture.target, at("2026-10-10T08:00:00Z")).status).toBe("repaired");
    expect(readFeedLanded(fixture.target.stateDir).record?.period).toBe("2026-10-10");
    writeFileSync(path.join(fixture.source, "a.txt"), "after cutoff\n");
    expect(refreshVolumeFeed(fixture.target, at("2026-10-10T10:30:00Z")).status).toBe("frozen");
    expect(served("a.txt")).toBe("alpha\n");
  });

  it("a held re-land refuses inputs that moved while it copied them", () => {
    const repo = datedFixture();
    const fonts = path.join(fixture.root, "fonts");
    mkdirSync(fonts);
    writeFileSync(path.join(fonts, "f.woff2"), "font\n");
    fixture.target.include = [{ from: fonts, to: "fonts" }];
    commitOn(repo, "data/2026-10-09", { "day.txt": "09\n" });
    refreshVolumeFeed(fixture.target, at("2026-10-09T08:00:00Z"));
    const servedLink = link(), file = path.join(fixture.volume, servedLink, "day.txt");
    chmodSync(path.dirname(file), 0o755);
    chmodSync(file, 0o644);
    writeFileSync(file, "TAMPER\n");
    // The include changes between the revision check and the copy.
    const exec: FeedExec = (command, args, options) => {
      if (args.includes("archive")) writeFileSync(path.join(fonts, "f.woff2"), "moved\n");
      return hostExec(command, args, options);
    };
    expect(() => refreshVolumeFeed(fixture.target, { exec, ...at("2026-10-09T11:00:00Z") })).toThrow(/the source moved while [0-9a-f]{12} was being re-landed/u);
    expect(link()).toBe(servedLink);
  });

  it("freezes a fixed ref and a directory source for the rest of the period they were landed in", () => {
    fixture = createFeedFixture({ freeze: FREEZE });
    refreshVolumeFeed(fixture.target, at("2026-10-09T08:00:00Z"));
    writeFileSync(path.join(fixture.source, "a.txt"), "after cutoff\n");
    expect(refreshVolumeFeed(fixture.target, at("2026-10-09T10:30:00Z")).status).toBe("frozen");
    expect(served("a.txt")).toBe("alpha\n");
    // A held volume never advances, not even to repair itself from a source that moved on.
    const servedLink = link(), file = path.join(fixture.volume, servedLink, "a.txt");
    chmodSync(path.dirname(file), 0o755);
    chmodSync(file, 0o644);
    writeFileSync(file, "ALPHA\n");
    const held = refreshVolumeFeed(fixture.target, at("2026-10-09T10:40:00Z"));
    expect(held.status).toBe("tampered");
    expect(held.findings.join("\n")).toMatch(/held at [0-9a-f]{12} and its source no longer reproduces it/u);
    expect(link()).toBe(servedLink);
    expect(refreshVolumeFeed(fixture.target, at("2026-10-10T06:00:00Z")).status).toBe("landed");
    expect(served("a.txt")).toBe("after cutoff\n");
  });
});

describe("dated feed paths", () => {
  const tamper = (name: string): void => {
    const file = path.join(fixture.volume, link(), name);
    chmodSync(path.dirname(file), 0o755);
    chmodSync(file, 0o644);
    writeFileSync(file, "TAMPER\n");
  };

  it("expands path placeholders like the ref, and leaves literal paths and an absent list alone", () => {
    const instant = new Date("2026-10-09T22:30:00Z");
    expect(expandFeedPaths(["${date:Europe/Berlin}", "notes/${date}", "shared"], instant)).toEqual(["2026-10-10", "notes/2026-10-09", "shared"]);
    expect(expandFeedPaths(undefined, instant)).toBeUndefined();
  });

  it("feeds only the dated directory of the day, holds the landed paths while frozen or waiting, and advances with the next day", () => {
    const repo = datedFixture();
    fixture.target.source = { ...fixture.target.source, paths: ["${date:Europe/Berlin}", "shared"] } as typeof fixture.target.source;
    commitOn(repo, "data/2026-10-09", { "2026-10-08/old.txt": "08\n", "2026-10-09/day.txt": "09\n", "code/tool.txt": "code\n", "shared/s.txt": "s\n" });
    expect(refreshVolumeFeed(fixture.target, at("2026-10-09T07:00:00Z")).status).toBe("landed");
    expect(served("2026-10-09/day.txt")).toBe("09\n");
    expect(served("shared/s.txt")).toBe("s\n");
    for (const absent of ["2026-10-08", "code", "README.md"]) expect(existsSync(path.join(fixture.volume, "current", absent))).toBe(false);
    expect(readFeedLanded(fixture.target.stateDir).record?.identity.source).toMatchObject({ paths: ["2026-10-09", "shared"], ref: "data/2026-10-09" });
    // Frozen after the cutoff, then waiting into the next day: a heal re-lands the paths it landed, not
    // today's expansion (2026-10-10 does not exist at the served commit).
    expect(refreshVolumeFeed(fixture.target, at("2026-10-09T10:30:00Z")).status).toBe("frozen");
    tamper("2026-10-09/day.txt");
    expect(refreshVolumeFeed(fixture.target, at("2026-10-09T23:30:00Z")).status).toBe("repaired");
    expect(served("2026-10-09/day.txt")).toBe("09\n");
    commitOn(repo, "data/2026-10-10", { "2026-10-10/day.txt": "10\n", "shared/s.txt": "s\n" });
    expect(refreshVolumeFeed(fixture.target, at("2026-10-10T05:00:00Z")).status).toBe("landed");
    expect(served("2026-10-10/day.txt")).toBe("10\n");
    expect(existsSync(path.join(fixture.volume, "current", "2026-10-09"))).toBe(false);
  });

  it("refuses a dated path the chosen ref does not carry, landing nothing", () => {
    const repo = datedFixture();
    fixture.target.source = { ...fixture.target.source, paths: ["${date:Europe/Berlin}"] } as typeof fixture.target.source;
    commitOn(repo, "data/2026-10-09", { "2026-10-08/old.txt": "08\n" });
    expect(() => refreshVolumeFeed(fixture.target, at("2026-10-09T07:00:00Z"))).toThrow(/cannot resolve data\/2026-10-09 \(2026-10-09\)/u);
    expect(existsSync(path.join(fixture.volume, "current"))).toBe(false);
  });

  it("does not count a volume frozen when the paths chosen now differ from the ones it landed", () => {
    const target = { freeze: FREEZE, source: { fetch: false, kind: "git", ref: "main", repo: "/r" } } as never;
    const record = { identity: { source: { kind: "git", paths: ["2026-10-09"], ref: "main" } }, period: "2026-10-09" } as unknown as FeedLandedRecord;
    const now = new Date("2026-10-09T10:30:00Z");
    expect(feedFrozen(target, record, "main", now, ["2026-10-09"])).toBe(true);
    expect(feedFrozen(target, record, "main", now, ["2026-10-10"])).toBe(false);
    expect(feedFrozen(target, record, "main", now)).toBe(false);
  });
});
