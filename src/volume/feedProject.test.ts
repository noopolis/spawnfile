import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../cli/runCli.js";
import { compileProject } from "../compiler/index.js";
import { findDeclaredVolumeFeeds, resolveFeedTarget, resolveVolumeHostPath, toFeedTarget } from "./feedProject.js";
import { createFeedFixture, type FeedFixture } from "./feedTestKit.js";

let fixture: FeedFixture;
afterEach(() => fixture?.cleanup());

const agentSpawnfile = (resource: string[]): string => [
  'spawnfile_version: "0.1"', "kind: agent", "name: analyst", "runtime: openclaw",
  "execution:", "  model:", "    primary:", "      provider: anthropic", "      name: claude-sonnet-4-5", "      auth:", "        method: claude-code",
  "workspace:", "  resources:", ...resource.map((line) => `    ${line}`), ""
].join("\n");

const volumeLines = ["- id: shared-data", "  kind: volume", "  name: shared-data-vol", "  mount: ./repos/shared-data", "  mode: mutable"];
const feedLines = ["  feed:", "    directory: ../source", "    keep: 2", "    validate: [\"sh\", \"check.sh\"]"];

const project = (lines: string[]): string => {
  const dir = path.join(fixture.root, "org");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "Spawnfile"), agentSpawnfile(lines));
  writeFileSync(path.join(dir, "check.sh"), 'test -f "$SPAWNFILE_FEED_TREE/a.txt"\n');
  return dir;
};

const listFiles = (root: string, prefix = ""): string[] => readdirSync(path.join(root, prefix), { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory() ? listFiles(root, path.join(prefix, entry.name)) : [path.join(prefix, entry.name)]).sort();

describe("fed volume project resolution", () => {
  it("finds the declared feed and resolves its paths against the declaring manifest", async () => {
    fixture = createFeedFixture();
    const dir = project([...volumeLines, ...feedLines]);
    const feeds = await findDeclaredVolumeFeeds(dir);
    expect(feeds).toEqual([{ base: dir, feed: { directory: "../source", keep: 2, validate: ["sh", "check.sh"] }, id: "shared-data", name: "shared-data-vol" }]);
    const target = await resolveFeedTarget(dir, "shared-data", { volumePath: fixture.volume });
    expect(target).toMatchObject({
      keep: 2, resourceId: "shared-data", source: { directory: fixture.source, kind: "directory" },
      stateDir: path.join(path.dirname(fixture.volume), "spawnfile-feed"), validate: { command: ["sh", "check.sh"], cwd: dir }, volume: fixture.volume, volumeName: "shared-data-vol"
    });
    await expect(resolveFeedTarget(dir, "other")).rejects.toThrow(/no fed volume other[\s\S]*fed volumes: shared-data/u);
  });

  it("resolves a git feed against the declaring manifest with fetch and ref defaults", () => {
    fixture = createFeedFixture();
    const declared = { base: "/org", feed: { git: { repo: "../source" } }, id: "d", name: "n" };
    expect(toFeedTarget(declared, { stateDir: "/state", volumePath: "/vol/_data" })).toMatchObject({
      healLimit: 3, keep: 1, source: { fetch: false, kind: "git", ref: "HEAD", repo: "/source" }, stateDir: "/state", volume: "/vol/_data"
    });
    const fetched = toFeedTarget({ ...declared, feed: { git: { fetch: true, paths: ["a"], ref: "main", repo: "/r" }, owner: "1:1" } }, { fetch: false, healLimit: 5, volumePath: "/vol/_data" });
    expect(fetched).toMatchObject({ healLimit: 5, owner: "1:1", source: { fetch: false, paths: ["a"], ref: "main", repo: "/r" }, stateDir: "/vol/spawnfile-feed" });
  });

  it("asks docker for a named volume's host path and explains when it cannot", () => {
    fixture = createFeedFixture();
    expect(resolveVolumeHostPath("vol", { exec: (command, args) => { expect([command, ...args]).toEqual(["docker", "volume", "inspect", "--format", "{{.Mountpoint}}", "vol"]); return Buffer.from("/var/lib/docker/volumes/vol/_data\n"); } }))
      .toBe("/var/lib/docker/volumes/vol/_data");
    expect(() => resolveVolumeHostPath("vol", { exec: () => { throw new Error("no such volume"); } })).toThrow(/cannot find the host path of volume vol: no such volume[\s\S]*--volume-path/u);
    expect(() => resolveVolumeHostPath("vol", { exec: () => Buffer.from("relative") })).toThrow(/unexpected mountpoint/u);
  });

  it("compiles a fed volume exactly like the same volume without a feed", async () => {
    fixture = createFeedFixture();
    const plain = project(volumeLines);
    const plainOut = path.join(fixture.root, "out-plain");
    await compileProject(plain, { outputDirectory: plainOut });
    const fed = project([...volumeLines, ...feedLines]);
    const fedOut = path.join(fixture.root, "out-fed");
    await compileProject(fed, { outputDirectory: fedOut });
    const files = listFiles(plainOut).filter((file) => !file.endsWith("spawnfile-report.json"));
    expect(listFiles(fedOut).filter((file) => !file.endsWith("spawnfile-report.json"))).toEqual(files);
    // Only the generation timestamp may differ: the feed is a host-side declaration the image never sees.
    const normalized = (root: string, file: string): string => readFileSync(path.join(root, file), "utf8").replaceAll(root, "OUT").replace(/"generated_at": "[^"]+"/gu, "");
    const differing = files.filter((file) => normalized(plainOut, file) !== normalized(fedOut, file));
    expect(differing).toEqual([]);
  }, 60_000);
});

describe("spawnfile volume", () => {
  it("refreshes and verifies a fed volume and reports through exit codes", async () => {
    fixture = createFeedFixture();
    const dir = project([...volumeLines, ...feedLines]);
    const out: string[] = [], err: string[] = [];
    const streams = { stderr: (line: string) => err.push(line), stdout: (line: string) => out.push(line) };
    const run = (...args: string[]) => runCli(["volume", ...args, "shared-data", dir, "--volume-path", fixture.volume], streams);
    expect(await run("refresh", "--json")).toBe(0);
    expect(JSON.parse(out.at(-1) as string)).toMatchObject({ previous: null, status: "landed" });
    expect(await run("verify")).toBe(0);
    expect(out.at(-1)).toMatch(/^current [0-9a-f]{64}$/u);
    writeFileSync(path.join(fixture.volume, "planted"), "x");
    expect(await run("verify")).toBe(1);
    expect(err.join("\n")).toMatch(/finding: planted is a name this host never writes/u);
    expect(await run("refresh", "--no-fetch", "--heal-limit", "2")).toBe(1);
    expect(await run("refresh", "--heal-limit", "0")).toBe(2);
  });
});
