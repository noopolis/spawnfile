import { readFile, realpath, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkSiblingBuildFreshness, type SiblingBuildFacts, type SiblingFileFact } from "./siblingBuildFreshness.js";

async function factsFor(packageName: string): Promise<SiblingBuildFacts> {
  let packageDirectory = await realpath(path.join(fileURLToPath(new URL("../../", import.meta.url)), "node_modules", packageName));
  let packageJsonPath: string | undefined;
  while (packageDirectory !== path.dirname(packageDirectory)) {
    try {
      await stat(path.join(packageDirectory, "package.json"));
      packageJsonPath = path.join(packageDirectory, "package.json");
      break;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      packageDirectory = path.dirname(packageDirectory);
    }
  }
  expect(packageJsonPath).toBeDefined();
  const packageJson = JSON.parse(await readFile(packageJsonPath!, "utf8")) as { name?: unknown };
  expect(packageJson.name).toBe(packageName);
  const sourceDirectory = path.join(packageDirectory, "src");
  const sourceFiles = await files(sourceDirectory, ".ts");
  return {
    packageName,
    packageDirectory,
    hasSourceDirectory: sourceFiles.length > 0,
    sourceFiles,
    outputFiles: await files(path.join(packageDirectory, "dist"), ".js")
  };
}

async function exists(filePath: string): Promise<boolean> { try { await stat(filePath); return true; } catch { return false; } }
async function files(directory: string, suffix: string): Promise<SiblingFileFact[]> {
  if (!await exists(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return files(filePath, suffix);
    if (!entry.isFile() || !entry.name.endsWith(suffix)) return [];
    return [{ path: filePath, mtimeMs: (await stat(filePath)).mtimeMs }];
  }))).flat();
}

describe("linked sibling build freshness", () => {
  it("inspects and validates Stele and Mneme", async () => {
    const results = await Promise.all(["@noopolis/stele", "@noopolis/mneme"].map(async (name) => {
      const facts = await factsFor(name);
      const result = checkSiblingBuildFreshness(facts);
      expect(result.ok, result.message).toBe(true);
      expect(result.packageName).toBe(name);
      if (result.linked) {
        expect(result.sourcesScanned).toBeGreaterThan(0);
        expect(result.outputsScanned).toBeGreaterThan(0);
      } else {
        console.log(`sibling freshness: ${name} passed as published (no linked source checkout)`);
      }
      return { name, result };
    }));
    expect(results.map(({ name }) => name).sort()).toEqual(["@noopolis/mneme", "@noopolis/stele"]);
    console.log(`sibling freshness: ${results.map(({ result }) => `${result.packageName} linked=${result.linked} sources=${result.sourcesScanned} outputs=${result.outputsScanned} ok=${result.ok}`).join("; ")}`);
  });
});
