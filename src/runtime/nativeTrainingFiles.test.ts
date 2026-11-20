import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import type { TrialDocker } from "../compiler/training/trial/index.js";
import { nativeInputSync, readNativeFile } from "./nativeTrainingFiles.js";

// Exercise the same Node programs the Docker commands run inside a trial.
const localNode: TrialDocker = (args, options) => new Promise((resolve, reject) => {
  const child = execFile(process.execPath, [...args.slice(args.indexOf("node") + 1)], (error, bytes) => {
    if (error) reject(error);
    else resolve(bytes);
  });
  child.stdin!.end(options?.stdin);
});

it("stages each selected input once and preserves exact output bytes across turns", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "spawnfile-native-io-"));
  try {
    const source = path.join(root, "host");
    const input = path.join(source, "inputs", "source");
    const workspace = path.join(root, "trial");
    await mkdir(workspace);
    const sync = nativeInputSync(localNode, "fixture", source, workspace);
    await sync();
    await mkdir(input, { recursive: true });
    const bytes = "\uFEFF leading and trailing  \n\n";
    await writeFile(path.join(input, "first"), bytes);
    await sync();
    const first = path.join(workspace, "inputs/source/first");
    expect(await readNativeFile(localNode, "fixture", first, [workspace])).toBe(bytes);
    await writeFile(path.join(input, "second"), "next");
    await sync();
    expect(await readFile(path.join(workspace, "inputs/source/second"), "utf8")).toBe("next");
    expect(await readNativeFile(localNode, "fixture", path.join(workspace, "unwritten"), [workspace])).toBeNull();
    await link(first, path.join(workspace, "duplicate"));
    await expect(readNativeFile(localNode, "fixture", first, [workspace])).rejects.toThrow("unshared regular file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
