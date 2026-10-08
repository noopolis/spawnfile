import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FEED_IDENTITY_FILE } from "./feedLayout.js";
import { resolveFeedContent } from "./feedPrepare.js";
import { refreshVolumeFeed } from "./feedRefresh.js";
import { hostExec } from "./feedSource.js";
import { createFeedFixture, writeSourceFiles, type FeedFixture } from "./feedTestKit.js";
import type { FeedPrepare } from "./feedTarget.js";

let fixture: FeedFixture;
afterEach(() => fixture?.cleanup());

const IMAGE = `node:22-bookworm-slim@sha256:${"b".repeat(64)}`;
const current = (): string => readlinkSync(path.join(fixture.volume, "current"));
const servedFile = (name: string): string => readFileSync(path.join(fixture.volume, "current", name), "utf8");
const runs = (): number => { try { return readFileSync(path.join(fixture.root, "runs"), "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };

/** A host prepare that counts its runs outside the tree and installs a stand-in dependency. */
const hostPrepare = (script = "mkdir -p node_modules/dep && echo built > node_modules/dep/index.js"): FeedPrepare =>
  ({ command: ["sh", "-c", `echo run >> ${JSON.stringify(path.join(fixture.root, "runs"))} && ${script}`], kind: "host", timeoutMs: 10_000 });

/** A docker stand-in: logs its argv, then runs the command in the host side of the one --volume mount. */
const fakeDocker = (): { docker: string; log: string } => {
  const docker = path.join(fixture.root, "docker"), log = path.join(fixture.root, "docker.log");
  writeFileSync(docker, [
    "#!/bin/sh",
    `echo "$*" >> ${JSON.stringify(log)}`,
    'if [ "$1" = rm ]; then exit 0; fi',
    'host=""',
    'while [ $# -gt 0 ]; do case "$1" in',
    '  --volume) host="${2%%:*}"; shift 2;;',
    "  --env|--workdir|--name|--platform|--user|--network) shift 2;;",
    "  run|--rm) shift;;",
    "  *) break;;",
    "esac; done",
    'shift; cd "$host" && exec "$@"', ""
  ].join("\n"), { mode: 0o755 });
  return { docker, log };
};

const rewrite = (file: string, content: string): void => {
  chmodSync(path.dirname(file), 0o755);
  chmodSync(file, 0o644);
  writeFileSync(file, content);
};

describe("feed prepare", () => {
  it("runs prepare in the staged tree before validation and serves its output; an unchanged refresh runs nothing", () => {
    fixture = createFeedFixture();
    fixture.target.prepare = hostPrepare();
    fixture.target.validate = { command: ["sh", "-c", 'test -f "$SPAWNFILE_FEED_TREE/node_modules/dep/index.js"'], cwd: fixture.root, timeoutMs: 10_000 };
    const landed = refreshVolumeFeed(fixture.target);
    expect(landed.status).toBe("landed");
    expect(servedFile("node_modules/dep/index.js")).toBe("built\n");
    expect(servedFile("a.txt")).toBe("alpha\n");
    const identity = JSON.parse(readFileSync(path.join(fixture.volume, FEED_IDENTITY_FILE), "utf8"));
    expect(identity.source.prepared).toMatchObject({ include: [], prepare: { image: null }, source_revision: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(identity.source.prepared.source_revision).not.toBe(landed.revision);
    expect(refreshVolumeFeed(fixture.target).status).toBe("current");
    expect(runs()).toBe(1);
  });

  it("a failed prepare aborts the refresh and leaves current untouched", () => {
    fixture = createFeedFixture();
    fixture.target.prepare = hostPrepare();
    refreshVolumeFeed(fixture.target);
    const before = current();
    writeSourceFiles(fixture.source, { "a.txt": "beta\n" });
    fixture.target.prepare = hostPrepare("echo install exploded >&2; exit 7");
    expect(() => refreshVolumeFeed(fixture.target)).toThrow(/prepare command for shared-data exited 7:\ninstall exploded; nothing was landed/u);
    expect(current()).toBe(before);
    expect(servedFile("a.txt")).toBe("alpha\n");
    expect(readdirSync(path.join(fixture.volume, "trees"))).toHaveLength(1);
    expect(readdirSync(path.join(fixture.target.stateDir, "staging"))).toEqual([]);
    fixture.target.prepare = hostPrepare("rm -rf ./* && true");
    expect(() => refreshVolumeFeed(fixture.target)).toThrow(/left an empty tree/u);
    fixture.target.prepare = { command: ["sleep", "5"], kind: "host", timeoutMs: 100 };
    expect(() => refreshVolumeFeed(fixture.target)).toThrow(/did not finish within 0s/u);
    fixture.target.prepare = { command: [path.join(fixture.root, "absent")], kind: "host", timeoutMs: 1000 };
    expect(() => refreshVolumeFeed(fixture.target)).toThrow(/could not run/u);
    expect(current()).toBe(before);
  });

  it("changes the revision when the recipe changes, without running anything to decide it", () => {
    fixture = createFeedFixture();
    fixture.target.prepare = hostPrepare();
    const first = resolveFeedContent(fixture.target, { exec: hostExec }).revision;
    fixture.target.prepare = hostPrepare("true");
    expect(resolveFeedContent(fixture.target, { exec: hostExec }).revision).not.toBe(first);
    const image: FeedPrepare = { command: ["npm", "ci"], dockerCommand: "docker", image: IMAGE, kind: "image", network: true, platform: "linux/amd64", timeoutMs: 1000 };
    fixture.target.prepare = image;
    const amd = resolveFeedContent(fixture.target, { exec: hostExec }).revision;
    fixture.target.prepare = { ...image, platform: "linux/arm64" };
    expect(resolveFeedContent(fixture.target, { exec: hostExec }).revision).not.toBe(amd);
    expect(runs()).toBe(0);
  });

  it("runs an image prepare through docker on the declared platform and removes a failed container", () => {
    fixture = createFeedFixture();
    const { docker, log } = fakeDocker();
    fixture.target.prepare = { command: ["sh", "-c", "mkdir node_modules && echo native > node_modules/addon.node"], dockerCommand: docker, image: IMAGE, kind: "image", network: false, platform: "linux/arm64", timeoutMs: 10_000 };
    expect(refreshVolumeFeed(fixture.target).status).toBe("landed");
    expect(servedFile("node_modules/addon.node")).toBe("native\n");
    const invocation = readFileSync(log, "utf8");
    expect(invocation).toMatch(/^run --rm --name spawnfile-feed-[0-9a-f]{16} --platform linux\/arm64 /u);
    expect(invocation).toContain("--network none");
    expect(invocation).toContain(":/spawnfile/feed --workdir /spawnfile/feed");
    expect(invocation).toContain(`SPAWNFILE_FEED_TREE=/spawnfile/feed ${IMAGE} sh -c`);
    writeSourceFiles(fixture.source, { "a.txt": "beta\n" });
    fixture.target.prepare = { ...fixture.target.prepare, command: ["false"] };
    expect(() => refreshVolumeFeed(fixture.target)).toThrow(/prepare command for shared-data exited 1/u);
    expect(readFileSync(log, "utf8")).toMatch(/\nrm --force spawnfile-feed-[0-9a-f]{16}\n$/u);
  });

  it("re-lands a drifted prepared tree from the cache, and rebuilds when the cache no longer matches its digest", () => {
    fixture = createFeedFixture();
    fixture.target.prepare = hostPrepare();
    const landed = refreshVolumeFeed(fixture.target).revision as string;
    expect(runs()).toBe(1);
    const lines: string[] = [];
    rewrite(path.join(fixture.volume, current(), "node_modules", "dep", "index.js"), "BUILT\n");
    expect(refreshVolumeFeed(fixture.target, { log: (line) => lines.push(line) }).status).toBe("repaired");
    expect(servedFile("node_modules/dep/index.js")).toBe("built\n");
    expect(current()).toBe(`trees/${landed}.1`);
    expect(runs()).toBe(1);
    expect(lines.join("\n")).toMatch(/reused the prepared tree/u);
    writeFileSync(path.join(fixture.target.stateDir, "prepared", landed, "node_modules", "dep", "index.js"), "poisoned\n");
    rewrite(path.join(fixture.volume, current(), "node_modules", "dep", "index.js"), "BUILT\n");
    expect(refreshVolumeFeed(fixture.target, { log: (line) => lines.push(line) }).status).toBe("repaired");
    expect(servedFile("node_modules/dep/index.js")).toBe("built\n");
    expect(runs()).toBe(2);
    expect(lines.join("\n")).toMatch(/no longer matches its digest/u);
  });

  it("keeps only the newest prepared trees in the cache", () => {
    fixture = createFeedFixture();
    fixture.target.prepare = hostPrepare();
    for (const content of ["one\n", "two\n", "three\n"]) {
      writeSourceFiles(fixture.source, { "a.txt": content });
      refreshVolumeFeed(fixture.target);
    }
    expect(readdirSync(path.join(fixture.target.stateDir, "prepared")).filter((name) => name.endsWith(".json"))).toHaveLength(2);
  });
});

describe("feed include", () => {
  it("stages host directories into the tree before prepare, and a changed include is a new revision", () => {
    fixture = createFeedFixture();
    const fonts = path.join(fixture.root, "fonts");
    writeSourceFiles(fonts, { "serif.woff2": "font-bytes\n" });
    fixture.target.include = [{ from: fonts, to: "assets/fonts" }];
    fixture.target.prepare = hostPrepare("test -f assets/fonts/serif.woff2");
    const first = refreshVolumeFeed(fixture.target);
    expect(servedFile("assets/fonts/serif.woff2")).toBe("font-bytes\n");
    const identity = JSON.parse(readFileSync(path.join(fixture.volume, FEED_IDENTITY_FILE), "utf8"));
    expect(identity.source.prepared.include).toEqual([{ digest: expect.stringMatching(/^[0-9a-f]{64}$/u), to: "assets/fonts" }]);
    expect(refreshVolumeFeed(fixture.target).status).toBe("current");
    writeSourceFiles(fonts, { "serif.woff2": "new-font\n" });
    expect(refreshVolumeFeed(fixture.target)).toMatchObject({ previous: first.revision, status: "landed" });
    expect(servedFile("assets/fonts/serif.woff2")).toBe("new-font\n");
  });

  it("never replaces fed files and never follows a staged symlink out of the tree", () => {
    fixture = createFeedFixture();
    const fonts = path.join(fixture.root, "fonts");
    writeSourceFiles(fonts, { "serif.woff2": "font\n" });
    fixture.target.include = [{ from: fonts, to: "a.txt" }];
    expect(() => refreshVolumeFeed(fixture.target)).toThrow(/include target a\.txt already exists in the fed tree/u);
    const outside = path.join(fixture.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, path.join(fixture.source, "assets"));
    fixture.target.include = [{ from: fonts, to: "assets/fonts" }];
    expect(() => refreshVolumeFeed(fixture.target)).toThrow(/passes through assets, which is not a directory/u);
    expect(readdirSync(outside)).toEqual([]);
    fixture.target.include = [{ from: path.join(fixture.root, "missing"), to: "x" }];
    expect(() => refreshVolumeFeed(fixture.target)).toThrow(/include directory .* does not exist/u);
    fixture.target.include = [{ from: path.join(fonts, "serif.woff2"), to: "x" }];
    expect(() => refreshVolumeFeed(fixture.target)).toThrow(/is not a directory/u);
    expect(existsSync(path.join(fixture.volume, "current"))).toBe(false);
  });
});
