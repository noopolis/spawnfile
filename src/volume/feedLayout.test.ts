import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertOutsideVolume, assertRealDirectory, assertSameDevice, ownAndFreeze, pointCurrent, removeTree, treeShape } from "./feedLayout.js";
import { buildFeedManifest, compareFeedManifest, manifestDrift } from "./feedManifest.js";
import { createFeedFixture, type FeedFixture } from "./feedTestKit.js";

let fixture: FeedFixture;
afterEach(() => fixture?.cleanup());

describe("fed volume layout rules", () => {
  it("refuses symlinks and files where a host directory belongs", () => {
    fixture = createFeedFixture();
    expect(assertRealDirectory(path.join(fixture.root, "absent"), "x")).toBeNull();
    symlinkSync("/etc", path.join(fixture.root, "link"));
    expect(() => assertRealDirectory(path.join(fixture.root, "link"), "x")).toThrow(/symlink to "\/etc"/u);
    writeFileSync(path.join(fixture.root, "file"), "");
    expect(() => assertRealDirectory(path.join(fixture.root, "file"), "x")).toThrow(/not a directory/u);
    expect(treeShape(path.join(fixture.root, "file"))).toBe("file");
  });

  it("keeps host state and deletes outside the volume and on its filesystem", () => {
    fixture = createFeedFixture();
    expect(() => assertOutsideVolume(fixture.volume, fixture.volume, "x")).toThrow(/overlaps/u);
    expect(() => assertOutsideVolume(fixture.volume, path.join(fixture.volume, "trees"), "x")).toThrow(/overlaps/u);
    expect(() => assertOutsideVolume(fixture.volume, path.dirname(fixture.volume), "x")).toThrow(/overlaps/u);
    expect(() => assertOutsideVolume(fixture.volume, fixture.source, "x")).not.toThrow();
    expect(() => removeTree(path.join(fixture.volume, "trees"), { volume: fixture.volume })).toThrow(/overlaps/u);
    expect(() => assertSameDevice(fixture.volume, "/dev", "the trash")).toThrow(/cannot cross filesystems/u);
  });

  it("removes a symlink rather than following it, and a missing tree is a no-op", () => {
    fixture = createFeedFixture();
    const link = path.join(fixture.root, "link");
    symlinkSync(fixture.source, link);
    removeTree(link, { volume: fixture.volume });
    expect(existsSync(link)).toBe(false);
    expect(existsSync(path.join(fixture.source, "a.txt"))).toBe(true);
    removeTree(path.join(fixture.root, "absent"), { volume: fixture.volume });
  });

  it("freezes content without following symlinks and refuses special files", () => {
    fixture = createFeedFixture();
    const outside = path.join(fixture.root, "outside.txt");
    writeFileSync(outside, "", { mode: 0o644 });
    symlinkSync(outside, path.join(fixture.source, "escape"));
    mkdirSync(path.join(fixture.source, "dir"));
    ownAndFreeze(fixture.source, { volume: fixture.volume });
    expect(lstatSync(outside).mode & 0o777).toBe(0o644);
    expect(lstatSync(path.join(fixture.source, "dir")).mode & 0o222).toBe(0);
    expect(lstatSync(fixture.source).mode & 0o777).toBe(0o755);
    expect(() => ownAndFreeze(path.join(fixture.volume), { volume: fixture.volume })).toThrow(/overlaps/u);
    const special = path.join(fixture.root, "special");
    mkdirSync(special);
    execFileSync("mkfifo", [path.join(special, "pipe")]);
    expect(() => ownAndFreeze(special, { volume: fixture.volume })).toThrow(/special file/u);
  });

  it("refuses to replace a real entry at the link name", () => {
    fixture = createFeedFixture();
    writeFileSync(path.join(fixture.volume, "current"), "");
    expect(() => pointCurrent(fixture.volume, "trees/x", { tmpDir: fixture.root })).toThrow(/real file[\s\S]*mv -- /u);
  });
});

describe("fed tree manifests", () => {
  it("separates drift from a touched-but-identical file", () => {
    fixture = createFeedFixture();
    mkdirSync(path.join(fixture.source, "dir"));
    symlinkSync("a.txt", path.join(fixture.source, "link"));
    const manifest = buildFeedManifest(fixture.source, "r");
    expect(manifest.files).toBe(1);
    const later = new Date(Date.now() + 5_000);
    execFileSync("touch", ["-d", later.toISOString(), path.join(fixture.source, "a.txt")]);
    expect(compareFeedManifest(fixture.source, manifest)).toEqual({ changed: [], extra: [], missing: [], touched: ["a.txt"] });
    execFileSync("chmod", ["0700", path.join(fixture.source, "dir")]);
    execFileSync("ln", ["-sfn", "other", path.join(fixture.source, "link")]);
    writeFileSync(path.join(fixture.source, "new.txt"), "");
    expect(manifestDrift(compareFeedManifest(fixture.source, manifest))).toEqual(["new.txt added", "dir changed", "link changed"]);
    execFileSync("rm", ["-r", path.join(fixture.source, "dir")]);
    writeFileSync(path.join(fixture.source, "dir"), "");
    expect(compareFeedManifest(fixture.source, manifest).changed).toContain("dir");
  });
});
