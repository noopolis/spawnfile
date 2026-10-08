import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validateWorkspaceBundleTar } from "./workspaceBundleArtifacts.js";
import { BundleTarWriter, normalizeBundleMode, splitUstarPath, ustarHeader } from "./workspaceBundleTar.js";

const run = promisify(execFile);

describe("workspace bundle tar writer", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-bundle-tar-")); });
  afterEach(async () => { await rm(root, { force: true, recursive: true }); });

  const write = async (name: string, entries: Array<[string, string, 0o644 | 0o755]>) => {
    const writer = await BundleTarWriter.create(path.join(root, name));
    for (const [entry, content, mode] of entries) {
      await writer.begin(entry, Buffer.byteLength(content), mode);
      await writer.data(Buffer.from(content));
      await writer.end();
    }
    return writer.finish();
  };

  it("emits deterministic, validator-clean archives that system tar extracts", async () => {
    const long = `${"d".repeat(90)}/${"e".repeat(60)}/file.txt`;
    const entries: Array<[string, string, 0o644 | 0o755]> = [["a.txt", "alpha", 0o644], ["bin/run", "#!/bin/sh\n", 0o755], [long, "deep", 0o644], ["empty", "", 0o644]];
    const first = await write("one.tar", entries), second = await write("two.tar", entries);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ contentBytes: 19, fileCount: 4 });
    const bytes = await readFile(path.join(root, "one.tar"));
    expect(bytes.length).toBe(first.size);
    expect(() => validateWorkspaceBundleTar(bytes)).not.toThrow();
    await run("tar", ["-xf", "one.tar", "-C", root], { cwd: root });
    expect(await readFile(path.join(root, long), "utf8")).toBe("deep");
    const listing = (await run("tar", ["-tvf", "one.tar"], { cwd: root })).stdout;
    expect(listing).toMatch(/-rwxr-xr-x .*bin\/run/u);
  });

  it("refuses unsorted, duplicate, short, overlong and empty input", async () => {
    await expect(write("unsorted.tar", [["b", "1", 0o644], ["a", "1", 0o644]])).rejects.toThrow(/strict path order/u);
    await expect(write("duplicate.tar", [["a", "1", 0o644], ["a", "1", 0o644]])).rejects.toThrow(/strict path order/u);
    await expect(write("empty.tar", [])).rejects.toThrow(/no input files/u);
    const writer = await BundleTarWriter.create(path.join(root, "short.tar"));
    await writer.begin("a", 3, 0o644);
    await expect(writer.data(Buffer.from("toolong"))).rejects.toThrow(/grew/u);
    await expect(writer.end()).rejects.toThrow(/shrank/u);
    await expect(writer.begin("b", 0, 0o644)).rejects.toThrow(/not fully written/u);
    await expect(writer.finish()).rejects.toThrow(/not fully written/u);
    expect(() => splitUstarPath(`${"x".repeat(101)}`)).toThrow(/ustar bounds/u);
    expect(() => splitUstarPath(`${"p".repeat(160)}/name`)).toThrow(/ustar bounds/u);
    expect(splitUstarPath(`${"p".repeat(120)}/${"q".repeat(30)}/name`).prefix.toString()).toBe("p".repeat(120));
  });

  it("collapses modes to the executable bit and writes root-owned zero-mtime headers", () => {
    expect(normalizeBundleMode(0o100755)).toBe(0o755);
    expect(normalizeBundleMode(0o100700)).toBe(0o755);
    expect(normalizeBundleMode(0o100664)).toBe(0o644);
    const header = ustarHeader("file", 1, 0o644);
    expect(header.subarray(136, 147).toString("ascii")).toBe("00000000000");
    expect(header.subarray(265, 269).toString("ascii")).toBe("root");
  });
});
