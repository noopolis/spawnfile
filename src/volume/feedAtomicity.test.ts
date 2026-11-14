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
//   2. every tree listed under trees/ is complete for as long as it is inside the volume (nothing partial
//      is ever visible inside the volume, which is what a container start guard walking the volume sees).
// A retired tree leaves by one rename and is deleted outside the volume, so a listing that was already
// open when it left can come back short. That is the documented limit of holding a descriptor across a
// retirement, not a partial tree: names are never reused, so a tree still present AFTER a short count was
// inside the volume for the whole count, and only that is a violation.
// Each clean pass over `current` is reported with the generation it served, which is how the writer
// paces itself on the reader instead of on the clock. writeSync on the blocking pipe, because this
// loop never yields to an event loop that could flush a stream.
const READER = `
import { lstatSync, readdirSync, readFileSync, realpathSync, existsSync, writeSync } from "node:fs";
import path from "node:path";
const [volume, stop, expected] = process.argv.slice(2);
const want = Number(expected);
let passes = 0; const violations = [];
const count = (root) => readdirSync(root).reduce((total, dir) => total + readdirSync(path.join(root, dir)).length, 0);
const present = (target) => { try { lstatSync(target); return true; } catch { return false; } };
// Darwin's rename(2) over a symlink is not atomic for a lookup already in flight: APFS answers EINVAL.
// Linux, where fed volumes run and where CI holds this guarantee, never does.
const swapArtifact = (error) => process.platform === "darwin" && error.code === "EINVAL";
while (!existsSync(stop) && violations.length < 5) {
  let tree;
  try { tree = realpathSync(path.join(volume, "current")); } catch (error) { if (!swapArtifact(error)) violations.push("current unresolvable: " + error.code); continue; }
  try {
    const seen = new Set();
    let files = 0;
    for (const dir of readdirSync(tree)) for (const name of readdirSync(path.join(tree, dir))) { seen.add(readFileSync(path.join(tree, dir, name), "utf8")); files += 1; }
    if (files !== want || seen.size !== 1) violations.push("current tree " + path.basename(tree) + ": " + files + " files, " + seen.size + " generations");
    else writeSync(1, "served " + [...seen][0]);
  } catch (error) { violations.push("current tree read failed: " + error.code); }
  let names = [];
  try { names = readdirSync(path.join(volume, "trees")); } catch {}
  for (const name of names) {
    const target = path.join(volume, "trees", name);
    let files;
    try { files = count(target); } catch { continue; }
    if (files !== want && present(target)) violations.push("partial tree " + name + ": " + files + " files");
  }
  passes += 1;
}
writeSync(1, "result " + JSON.stringify({ passes, violations }) + "\\n");
`;

describe("fed volume atomicity", () => {
  it("never shows a concurrent reader a partial, mixed or missing tree across many swaps", async () => {
    fixture = createFeedFixture({ keep: 2 });
    writeSourceFiles(fixture.source, generation(0));
    refreshVolumeFeed(fixture.target);
    const script = path.join(fixture.root, "reader.mjs"), stop = path.join(fixture.root, "stop");
    writeFileSync(script, READER);
    const reader = spawn(process.execPath, [script, fixture.volume, stop, String(FILES)], { stdio: ["ignore", "pipe", "inherit"] });
    let output = "", closed = false, wake = (): void => undefined;
    reader.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); wake(); });
    const done = new Promise<void>((resolve) => reader.on("close", () => { closed = true; wake(); resolve(); }));
    // The writer swaps again only once the reader has served the generation just landed. The reader never
    // stops looping, so every swap still lands in the middle of a pass; but with `keep: 2` a tree is retired
    // two swaps after it stops being current, and the second of those swaps now waits for a whole later
    // pass. A pass over `current` therefore always finishes before its tree can leave the volume, on any
    // machine at any load, and every one of the generations is proven to have been read complete.
    const served = async (index: number): Promise<void> => {
      while (!closed && !output.includes(`served generation-${index}\n`)) await new Promise<void>((resolve) => { wake = resolve; });
    };
    await served(0);
    for (let index = 1; index <= 30 && !closed; index += 1) {
      writeSourceFiles(fixture.source, generation(index));
      expect(refreshVolumeFeed(fixture.target).status).toBe("landed");
      await served(index);
    }
    writeFileSync(stop, "");
    await done;
    const result = JSON.parse(output.slice(output.lastIndexOf("result ") + 7)) as { passes: number; violations: string[] };
    expect(result.violations).toEqual([]);
    expect(result.passes).toBeGreaterThan(30);
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
