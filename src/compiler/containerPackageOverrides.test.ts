import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { stageRuntimePackageOverrides } from "./containerPackageOverrides.js";

const createFakePackage = async (name: string, version: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-pkg-override-"));
  await mkdir(path.join(directory, "dist"), { recursive: true });
  await writeFile(path.join(directory, "dist", "index.js"), "export const value = 1;\n");
  await writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify({ name, version, files: ["dist"] }, null, 2)}\n`
  );
  return directory;
};

describe("stageRuntimePackageOverrides", () => {
  it("returns undefined and writes nothing when there are no overrides", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-vendor-out-"));

    await expect(stageRuntimePackageOverrides(outputDirectory, undefined)).resolves.toBeUndefined();
    await expect(stageRuntimePackageOverrides(outputDirectory, {})).resolves.toBeUndefined();
  });

  it("packs each overridden local package directory into the vendor build context", async () => {
    const daimonDirectory = await createFakePackage("@noopolis/daimon", "0.1.2");
    const mnemeDirectory = await createFakePackage("@noopolis/mneme", "0.1.1");
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-vendor-out-"));

    const resolved = await stageRuntimePackageOverrides(outputDirectory, {
      "@noopolis/daimon": daimonDirectory,
      "@noopolis/mneme": mnemeDirectory
    });

    expect(resolved?.["@noopolis/daimon"]?.filename).toBe("noopolis-daimon-0.1.2.tgz");
    expect(resolved?.["@noopolis/mneme"]?.filename).toBe("noopolis-mneme-0.1.1.tgz");

    const vendorFiles = (
      await readdir(path.join(outputDirectory, "container", "vendor"))
    ).sort();
    expect(vendorFiles).toEqual(["noopolis-daimon-0.1.2.tgz", "noopolis-mneme-0.1.1.tgz"]);
  }, 30_000);

  it("raises a compile_error naming the package when the local directory cannot be packed", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-vendor-out-"));
    const missingDirectory = path.join(outputDirectory, "does-not-exist");

    await expect(
      stageRuntimePackageOverrides(outputDirectory, { "@noopolis/daimon": missingDirectory })
    ).rejects.toMatchObject({ message: expect.stringContaining("@noopolis/daimon") });
  }, 30_000);
});
