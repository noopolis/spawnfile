import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const execute = promisify(execFile);
const sourceRoot = fileURLToPath(new URL(".", import.meta.url));
const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("copies both Daimon contract assets unchanged into the built runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-runtime-assets-"));
  roots.push(root);
  const runtime = path.join(root, "src", "runtime");
  await mkdir(path.join(runtime, "daimon"), { recursive: true });
  const script = path.join(runtime, "copyScaffoldAssets.ts");
  await cp(path.join(sourceRoot, "copyScaffoldAssets.ts"), script);
  const assets = ["contract-manifest.json", "contract-manifest.sha256"];
  for (const asset of assets) await cp(path.join(sourceRoot, "daimon", asset), path.join(runtime, "daimon", asset));

  await execute(process.execPath, ["--experimental-strip-types", script]);

  for (const asset of assets) {
    expect(await readFile(path.join(root, "dist", "runtime", "daimon", asset)))
      .toEqual(await readFile(path.join(sourceRoot, "daimon", asset)));
  }
});
