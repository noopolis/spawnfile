import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FEED_IDENTITY_FILE, VOLUME_RESOURCE_SENTINEL } from "./feedLayout.js";
import { acquireFeedLock } from "./feedLock.js";
import { feedIdentityFindings, readFeedLanded } from "./feedRecord.js";
import { feedResultClean, refreshVolumeFeed, verifyVolumeFeed } from "./feedRefresh.js";
import { createFeedFixture, writeSourceFiles, type FeedFixture } from "./feedTestKit.js";

let fixture: FeedFixture;
afterEach(() => fixture?.cleanup());

const current = (volume: string): string => readlinkSync(path.join(volume, "current"));
const trees = (volume: string): string[] => readdirSync(path.join(volume, "trees")).sort();

describe("refreshVolumeFeed", () => {
  it("lands a directory source behind current with a frozen tree and an identity record", () => {
    fixture = createFeedFixture();
    const result = refreshVolumeFeed(fixture.target);
    expect(result.status).toBe("landed");
    expect(feedResultClean(result)).toBe(true);
    expect(current(fixture.volume)).toBe(`trees/${result.revision}`);
    expect(readFileSync(path.join(fixture.volume, "current", "a.txt"), "utf8")).toBe("alpha\n");
    expect(lstatSync(path.join(fixture.volume, "trees", result.revision as string)).mode & 0o777).toBe(0o555);
    expect(lstatSync(path.join(fixture.volume, "current", "a.txt")).mode & 0o222).toBe(0);
    const identity = JSON.parse(readFileSync(path.join(fixture.volume, FEED_IDENTITY_FILE), "utf8"));
    expect(feedIdentityFindings(identity)).toEqual([]);
    expect(identity).toMatchObject({ files: 1, resource: "shared-data", revision: result.revision, source: { kind: "directory" }, volume: "shared-data-vol" });
    // The container's sentinel is never touched and the root keeps its mode.
    expect(readFileSync(path.join(fixture.volume, VOLUME_RESOURCE_SENTINEL), "utf8")).toBe("sha256:fixture\n");
    expect(lstatSync(fixture.volume).mode & 0o777).toBe(0o755);
    expect(readdirSync(path.join(fixture.target.stateDir, "staging"))).toEqual([]);
    expect(refreshVolumeFeed(fixture.target).status).toBe("current");
    expect(verifyVolumeFeed(fixture.target).status).toBe("current");
  });

  it("swaps to new content, keeps one retired tree, and deletes older ones outside the volume", () => {
    fixture = createFeedFixture();
    const first = refreshVolumeFeed(fixture.target).revision as string;
    writeSourceFiles(fixture.source, { "a.txt": "beta\n" });
    const second = refreshVolumeFeed(fixture.target);
    expect(second).toMatchObject({ previous: first, status: "landed" });
    expect(trees(fixture.volume)).toEqual([first, second.revision].sort());
    writeSourceFiles(fixture.source, { "a.txt": "gamma\n", "nested/b.txt": "b\n" });
    const third = refreshVolumeFeed(fixture.target).revision as string;
    expect(trees(fixture.volume)).toEqual([second.revision, third].sort());
    expect(readFileSync(path.join(fixture.volume, "current", "nested", "b.txt"), "utf8")).toBe("b\n");
    expect(readdirSync(path.join(fixture.target.stateDir, "trash"))).toEqual([]);
    expect(readFeedLanded(fixture.target.stateDir).record?.trees).toEqual([second.revision, third].sort());
    expect(existsSync(path.join(fixture.target.stateDir, "manifests", `${first}.json`))).toBe(false);
  });

  it("runs the declared validation hook on the staged tree and lands nothing when it rejects", () => {
    fixture = createFeedFixture();
    const hook = path.join(fixture.root, "check.sh");
    writeFileSync(hook, '#!/bin/sh\ntest -f "$SPAWNFILE_FEED_TREE/a.txt" || exit 3\ngrep -q alpha "$SPAWNFILE_FEED_TREE/a.txt" || { echo "content rejected" >&2; exit 4; }\n', { mode: 0o755 });
    fixture.target.validate = { command: [hook], cwd: fixture.root, timeoutMs: 10_000 };
    expect(refreshVolumeFeed(fixture.target).status).toBe("landed");
    writeSourceFiles(fixture.source, { "a.txt": "omega\n" });
    const before = current(fixture.volume);
    expect(() => refreshVolumeFeed(fixture.target)).toThrow(/validation command rejected[\s\S]*content rejected/u);
    expect(current(fixture.volume)).toBe(before);
    expect(trees(fixture.volume)).toHaveLength(1);
    expect(readdirSync(path.join(fixture.target.stateDir, "staging"))).toEqual([]);
  });

  it("reports a validation command that cannot run or overruns its time", () => {
    fixture = createFeedFixture();
    fixture.target.validate = { command: [path.join(fixture.root, "absent-hook")], cwd: fixture.root, timeoutMs: 10_000 };
    expect(() => refreshVolumeFeed(fixture.target)).toThrow(/could not run/u);
    fixture.target.validate = { command: ["sleep", "5"], cwd: fixture.root, timeoutMs: 100 };
    expect(() => refreshVolumeFeed(fixture.target)).toThrow(/did not finish within 0s/u);
    expect(existsSync(path.join(fixture.volume, "current"))).toBe(false);
  });

  it("refuses a volume the container has not initialized, a root off 0755, and state inside the volume", () => {
    fixture = createFeedFixture();
    renameSync(path.join(fixture.volume, VOLUME_RESOURCE_SENTINEL), path.join(fixture.root, "sentinel"));
    expect(() => refreshVolumeFeed(fixture.target)).toThrow(/start the organization once/u);
    expect(readdirSync(fixture.volume)).toEqual([]);
    renameSync(path.join(fixture.root, "sentinel"), path.join(fixture.volume, VOLUME_RESOURCE_SENTINEL));
    chmodSync(fixture.volume, 0o775);
    expect(() => refreshVolumeFeed(fixture.target)).toThrow(/must be 0755/u);
    chmodSync(fixture.volume, 0o755);
    expect(() => refreshVolumeFeed({ ...fixture.target, stateDir: path.join(fixture.volume, "state") })).toThrow(/outside the volume/u);
  });

  it("returns busy and changes nothing while another writer holds the lock", () => {
    fixture = createFeedFixture();
    const lock = acquireFeedLock(fixture.target.stateDir);
    expect(lock).not.toBeNull();
    expect(refreshVolumeFeed(fixture.target).status).toBe("busy");
    expect(existsSync(path.join(fixture.volume, "current"))).toBe(false);
    lock?.release();
    expect(refreshVolumeFeed(fixture.target).status).toBe("landed");
  });
});

describe("tamper verification and healing", () => {
  const rewrite = (file: string, content: string): void => {
    chmodSync(path.dirname(file), 0o755);
    chmodSync(file, 0o644);
    writeFileSync(file, content);
  };

  it("re-lands a same-size rewrite from the source, then suspends after the heal limit", () => {
    fixture = createFeedFixture({ healLimit: 2 });
    const landed = refreshVolumeFeed(fixture.target).revision as string;
    const file = path.join(fixture.volume, "trees", landed, "a.txt");
    rewrite(file, "ALPHA\n");
    expect(verifyVolumeFeed(fixture.target)).toMatchObject({ status: "tampered" });
    expect(verifyVolumeFeed(fixture.target).findings.join("\n")).toMatch(/a\.txt changed/u);
    const healed = refreshVolumeFeed(fixture.target);
    expect(healed.status).toBe("repaired");
    expect(feedResultClean(healed)).toBe(false);
    expect(readFileSync(path.join(fixture.volume, "current", "a.txt"), "utf8")).toBe("alpha\n");
    expect(readFeedLanded(fixture.target.stateDir).record?.heals).toEqual({ [landed]: 1 });
    rewrite(file, "ALPHA\n");
    expect(refreshVolumeFeed(fixture.target).status).toBe("repaired");
    rewrite(file, "ALPHA\n");
    expect(refreshVolumeFeed(fixture.target).status).toBe("suspended");
    expect(readFileSync(file, "utf8")).toBe("ALPHA\n");
  });

  it("clears the heal count once the volume verifies clean", () => {
    fixture = createFeedFixture();
    const landed = refreshVolumeFeed(fixture.target).revision as string;
    rewrite(path.join(fixture.volume, "trees", landed, "a.txt"), "ALPHA\n");
    refreshVolumeFeed(fixture.target);
    expect(refreshVolumeFeed(fixture.target).status).toBe("current");
    expect(readFeedLanded(fixture.target.stateDir).record?.heals).toEqual({});
  });

  it("re-lands a tree that vanished and restores a moved link and a forged identity", () => {
    fixture = createFeedFixture();
    const landed = refreshVolumeFeed(fixture.target).revision as string;
    const tree = path.join(fixture.volume, "trees", landed);
    chmodSync(tree, 0o755);
    renameSync(tree, path.join(fixture.root, "stolen"));
    expect(refreshVolumeFeed(fixture.target).status).toBe("repaired");
    expect(readFileSync(path.join(fixture.volume, "current", "a.txt"), "utf8")).toBe("alpha\n");

    const live = path.join(fixture.volume, "current");
    renameSync(live, path.join(fixture.root, "old-link"));
    symlinkSync("/etc", live);
    rmSync(path.join(fixture.volume, FEED_IDENTITY_FILE));
    writeFileSync(path.join(fixture.volume, FEED_IDENTITY_FILE), "{}\n");
    expect(refreshVolumeFeed(fixture.target).status).toBe("repaired");
    expect(current(fixture.volume)).toBe(`trees/${landed}`);
    expect(JSON.parse(readFileSync(path.join(fixture.volume, FEED_IDENTITY_FILE), "utf8")).revision).toBe(landed);
    expect(refreshVolumeFeed(fixture.target).status).toBe("current");
  });

  it("never deletes a real entry planted where the link belongs or an unknown name", () => {
    fixture = createFeedFixture();
    refreshVolumeFeed(fixture.target);
    const live = path.join(fixture.volume, "current");
    renameSync(live, path.join(fixture.root, "old-link"));
    mkdirSync(live);
    writeFileSync(path.join(fixture.volume, "notes.txt"), "planted\n");
    const result = refreshVolumeFeed(fixture.target);
    expect(result.status).toBe("tampered");
    expect(result.findings.join("\n")).toMatch(/current is a real entry[\s\S]*mv -- [\s\S]*notes\.txt is a name this host never writes/u);
    expect(lstatSync(live).isDirectory()).toBe(true);
    expect(readFileSync(path.join(fixture.volume, "notes.txt"), "utf8")).toBe("planted\n");
  });

  it("refuses to operate through a trees symlink and reports it as a finding", () => {
    fixture = createFeedFixture();
    const landed = refreshVolumeFeed(fixture.target).revision as string;
    const treesDir = path.join(fixture.volume, "trees");
    renameSync(treesDir, path.join(fixture.root, "real-trees"));
    symlinkSync(path.join(fixture.root, "real-trees"), treesDir);
    const result = refreshVolumeFeed(fixture.target);
    expect(result.status).toBe("tampered");
    expect(result.findings[0]).toMatch(/could not complete[\s\S]*symlink/u);
    expect(existsSync(path.join(fixture.root, "real-trees", landed, "a.txt"))).toBe(true);
  });

  it("reports a volume with nothing landed as not clean", () => {
    fixture = createFeedFixture();
    expect(verifyVolumeFeed(fixture.target)).toMatchObject({ findings: ["nothing has been landed in this volume yet"], status: "tampered" });
  });
});
