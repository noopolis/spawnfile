import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  await cp(path.join(sourceRoot, "daimon", "package-assets.json"), path.join(runtime, "daimon", "package-assets.json"));
  for (const asset of assets) await cp(path.join(sourceRoot, "daimon", asset), path.join(runtime, "daimon", asset));

  await execute(process.execPath, ["--experimental-strip-types", script]);

  for (const asset of assets) {
    expect(await readFile(path.join(root, "dist", "runtime", "daimon", asset)))
      .toEqual(await readFile(path.join(sourceRoot, "daimon", asset)));
  }
});

it("copies declared assets of another adapter without loading its code", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-runtime-assets-"));
  roots.push(root);
  const runtime = path.join(root, "src", "runtime");
  const adapter = path.join(runtime, "example");
  const script = path.join(runtime, "copyScaffoldAssets.ts");
  await mkdir(path.join(adapter, "scaffold-assets"), { recursive: true });
  await cp(path.join(sourceRoot, "copyScaffoldAssets.ts"), script);
  await writeFile(path.join(adapter, "index.ts"), "throw new Error('unexpected adapter import');");
  await writeFile(path.join(adapter, "package-assets.json"), '["scaffold-assets"]');
  await writeFile(path.join(adapter, "scaffold-assets", "starter.md"), "example");
  await writeFile(path.join(adapter, "scaffold-assets", "AGENTS.md"), "guide");
  await writeFile(path.join(adapter, "ignored.json"), "{}");

  await execute(process.execPath, ["--experimental-strip-types", script]);

  const destination = path.join(root, "dist", "runtime", "example");
  expect(await readFile(path.join(destination, "scaffold-assets", "starter.md"), "utf8")).toBe("example");
  await expect(readFile(path.join(destination, "scaffold-assets", "AGENTS.md"))).rejects.toMatchObject({code: "ENOENT"});
  await expect(readFile(path.join(destination, "ignored.json"))).rejects.toMatchObject({code: "ENOENT"});
});
