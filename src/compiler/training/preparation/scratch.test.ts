import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { claimTrainingPreparationScratch } from "./scratch.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
// `realpath`: the preparation parent is always canonical in production, and macOS `/var` is a symlink.
const temporary = async () => { const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "training-scratch-"))); roots.push(root); return root; };
const digest = `sha256:${"a".repeat(64)}`;

describe("training preparation scratch", () => {
  it("creates the directory when nothing is there", async () => {
    const staging = path.join(await temporary(), "scratch");
    const lines: string[] = [];
    await claimTrainingPreparationScratch(staging, digest, line => lines.push(line));
    expect(await readdir(staging)).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("reclaims a leftover from the same preparation and hands back an empty directory", async () => {
    const staging = path.join(await temporary(), "scratch");
    await mkdir(staging, { mode: 0o700 });
    await writeFile(path.join(staging, "state.json"), JSON.stringify({ digest, image: "sha256:b", staged: [], snapshots: [] }));
    await writeFile(path.join(staging, "launch.json"), "{}");
    const lines: string[] = [];
    await claimTrainingPreparationScratch(staging, digest, line => lines.push(line));
    expect(await readdir(staging)).toEqual([]);
    expect(lines[0]).toContain("Reusing the preparation scratch");
  });

  it("refuses a leftover from a different preparation and names how to clear it", async () => {
    const staging = path.join(await temporary(), "scratch");
    await mkdir(staging, { mode: 0o700 });
    await writeFile(path.join(staging, "state.json"), JSON.stringify({ digest: `sha256:${"c".repeat(64)}` }));
    await expect(claimTrainingPreparationScratch(staging, digest, () => undefined))
      .rejects.toThrow(/belongs to a different preparation .*; remove it to retry: rm -rf/u);
    expect(await readdir(staging)).toEqual(["state.json"]);
  });

  it("refuses a leftover that never recorded its identity, and never deletes it", async () => {
    const staging = path.join(await temporary(), "scratch");
    await mkdir(staging, { mode: 0o700 });
    await writeFile(path.join(staging, "half-staged"), "x");
    await expect(claimTrainingPreparationScratch(staging, digest, () => undefined))
      .rejects.toThrow(/never recorded its identity; remove it to retry: rm -rf/u);
    expect(await readdir(staging)).toEqual(["half-staged"]);
  });

  it("refuses a scratch path that is not a canonical directory", async () => {
    const root = await temporary();
    const staging = path.join(root, "scratch");
    await writeFile(staging, "not a directory");
    await expect(claimTrainingPreparationScratch(staging, digest, () => undefined)).rejects.toThrow(/not a canonical directory/u);
  });
});
