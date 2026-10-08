// No reader ever sees a half-written tree. A separate process reads the volume the way agents do while
// this process refreshes it over and over; any partial tree, missing file or unresolvable `current` is a
// violation. The link swap is also pinned deterministically through the LINK_OPS seam, because its race
// window is microseconds wide and a timing test alone cannot prove it.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LINK_OPS, pointCurrent, type LinkOps } from "./feedLayout.js";
import { refreshVolumeFeed } from "./feedRefresh.js";
import { createFeedFixture, writeSourceFiles, type FeedFixture } from "./feedTestKit.js";

let fixture: FeedFixture;
afterEach(() => fixture?.cleanup());

const FILES = 80;

const generation = (index: number): Record<string, string> =>
  Object.fromEntries(Array.from({ length: FILES }, (_, file) => [`d${file % 5}/f${String(file).padStart(3, "0")}.txt`, `generation-${index}\n`]));

// Plain ESM so the child needs no TypeScript loader. It checks two things on every pass:
//   1. `current` resolves, and the tree it resolves to holds every file, all of one generation;
//   2. every tree listed under trees/ that can still be opened is complete (nothing partial is ever
//      visible inside the volume, which is what a container start guard walking the volume would see).
const READER = `
import { readdirSync, readFileSync, realpathSync, existsSync } from "node:fs";
import path from "node:path";
const [volume, stop, expected] = process.argv.slice(2);
const want = Number(expected);
let passes = 0; const violations = [];
const count = (root) => readdirSync(root).reduce((total, dir) => total + readdirSync(path.join(root, dir)).length, 0);
while (!existsSync(stop) && violations.length < 5) {
  let tree;
  try { tree = realpathSync(path.join(volume, "current")); } catch (error) { if (passes > 0 || existsSync(path.join(volume, "current"))) violations.push("current unresolvable: " + error.code); continue; }
  try {
    const seen = new Set();
    let files = 0;
    for (const dir of readdirSync(tree)) for (const name of readdirSync(path.join(tree, dir))) { seen.add(readFileSync(path.join(tree, dir, name), "utf8")); files += 1; }
    if (files !== want || seen.size !== 1) violations.push("current tree " + path.basename(tree) + ": " + files + " files, " + seen.size + " generations");
  } catch (error) { violations.push("current tree read failed: " + error.code); }
  let names = [];
  try { names = readdirSync(path.join(volume, "trees")); } catch {}
  for (const name of names) {
    let files;
    try { files = count(path.join(volume, "trees", name)); } catch { continue; }
    if (files !== want) violations.push("partial tree " + name + ": " + files + " files");
  }
  passes += 1;
}
process.stdout.write(JSON.stringify({ passes, violations }));
`;

describe("fed volume atomicity", () => {
  it("never shows a concurrent reader a partial, mixed or missing tree across many swaps", async () => {
    fixture = createFeedFixture({ keep: 2 });
    writeSourceFiles(fixture.source, generation(0));
    refreshVolumeFeed(fixture.target);
    const script = path.join(fixture.root, "reader.mjs"), stop = path.join(fixture.root, "stop");
    writeFileSync(script, READER);
    const reader = spawn(process.execPath, [script, fixture.volume, stop, String(FILES)], { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    reader.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const done = new Promise<void>((resolve) => reader.on("close", () => resolve()));
    // Let the reader get going before the swaps start.
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (let index = 1; index <= 30; index += 1) {
      writeSourceFiles(fixture.source, generation(index));
      expect(refreshVolumeFeed(fixture.target).status).toBe("landed");
      await new Promise((resolve) => setImmediate(resolve));
    }
    writeFileSync(stop, "");
    await done;
    const result = JSON.parse(output) as { passes: number; violations: string[] };
    expect(result.violations).toEqual([]);
    expect(result.passes).toBeGreaterThan(20);
    expect(readFileSync(path.join(fixture.volume, "current", "d0", "f000.txt"), "utf8")).toBe("generation-30\n");
  }, 180_000);

  it("replaces the live link by rename and never unlinks it", () => {
    fixture = createFeedFixture();
    const live = path.join(fixture.volume, "current"), calls: string[] = [];
    const spy: LinkOps = {
      ...LINK_OPS,
      rename: (from, to) => { calls.push(`rename ${path.basename(String(from))} -> ${String(to) === live ? "LIVE" : String(to)}`); LINK_OPS.rename(from, to); },
      symlink: (target, at) => { if (String(at) === live) calls.push("symlink LIVE"); LINK_OPS.symlink(target, at); },
      unlink: (target) => { calls.push(String(target) === live ? "unlink LIVE" : "unlink tmp"); LINK_OPS.unlink(target); }
    };
    expect(pointCurrent(fixture.volume, "trees/one", { ops: spy, tmpDir: fixture.root })).toBe(true);
    expect(pointCurrent(fixture.volume, "trees/two", { ops: spy, tmpDir: fixture.root })).toBe(true);
    expect(pointCurrent(fixture.volume, "trees/two", { ops: spy, tmpDir: fixture.root })).toBe(false);
    expect(calls.filter((call) => call.includes("LIVE"))).toEqual([`rename .current.${process.pid}.tmp -> LIVE`, `rename .current.${process.pid}.tmp -> LIVE`]);
    expect(existsSync(path.join(fixture.root, `.current.${process.pid}.tmp`))).toBe(false);
  });
});
