import os from "node:os";
import path from "node:path";

import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { ensureDirectory, readUtf8File, removeDirectory, writeUtf8File } from "../filesystem/index.js";
import { applyRuntimePackageOverrides, assertRuntimePackageOverrideDistsBuilt } from "./runtimePackageOverrides.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("applyRuntimePackageOverrides", () => {
  it("replaces generated dependency specs only when overrides are supplied", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-runtime-overrides-"));
    temporaryDirectories.push(directory);
    const packageJsonPath = path.join(directory, "package.json");
    await writeUtf8File(packageJsonPath, '{"dependencies":{"@noopolis/daimon":"0.1.2"}}\n');

    await applyRuntimePackageOverrides(packageJsonPath, {
      "@noopolis/daimon": "file:/tmp/daimon",
      "@noopolis/mneme": "file:/tmp/mneme"
    });

    expect(JSON.parse(await readUtf8File(packageJsonPath))).toEqual({
      dependencies: {
        "@noopolis/daimon": "file:/tmp/daimon",
        "@noopolis/mneme": "file:/tmp/mneme"
      }
    });
  });

  it("leaves the generated package untouched without overrides", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-runtime-overrides-"));
    temporaryDirectories.push(directory);
    const packageJsonPath = path.join(directory, "package.json");
    const original = '{"dependencies":{"@noopolis/daimon":"0.1.2"}}\n';
    await writeUtf8File(packageJsonPath, original);

    await applyRuntimePackageOverrides(packageJsonPath, undefined);

    expect(await readUtf8File(packageJsonPath)).toBe(original);
  });
});

describe("assertRuntimePackageOverrideDistsBuilt", () => {
  it("resolves when every override directory has a built dist/index.js", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-runtime-overrides-"));
    temporaryDirectories.push(directory);
    await ensureDirectory(path.join(directory, "dist"));
    await writeUtf8File(path.join(directory, "dist", "index.js"), "export const value = 1;\n");

    await expect(
      assertRuntimePackageOverrideDistsBuilt({ "@noopolis/daimon": directory })
    ).resolves.toBeUndefined();
  });

  it("throws a runtime_error naming the package and directory when dist is missing", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-runtime-overrides-"));
    temporaryDirectories.push(directory);

    await expect(
      assertRuntimePackageOverrideDistsBuilt({ "@noopolis/daimon": directory })
    ).rejects.toMatchObject({
      code: "runtime_error",
      message: expect.stringContaining("@noopolis/daimon")
    });
  });
});
