import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sourceRoot = path.join(root, "src");
const footballToken = /football/iu;
type Record = { path: string; owner: "B106" | "Spawnfile"; disposition: "retain"; destination: string };
type Manifest = {
  version: "spawnfile.root-ownership-boundary.v2";
  scope: "src";
  token: "football";
  records: Record[];
  production_implementation_paths: string[];
};

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const candidate = path.join(directory, entry.name);
    return entry.isDirectory() ? files(candidate) : entry.name.endsWith(".ts") ? [candidate] : [];
  }))).flat();
}

test("root ownership census exactly classifies every plain football reference", async () => {
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, "ownership/rootOwnershipBoundary.json"), "utf8")) as Manifest;
  assert.deepEqual(Object.keys(manifest).sort(), ["production_implementation_paths", "records", "scope", "token", "version"]);
  assert.equal(manifest.version, "spawnfile.root-ownership-boundary.v2");
  assert.equal(manifest.scope, "src");
  assert.equal(manifest.token, "football");
  assert.deepEqual(manifest.production_implementation_paths, []);
  for (const record of manifest.records) {
    assert.deepEqual(Object.keys(record).sort(), ["destination", "disposition", "owner", "path"]);
    assert.equal(record.disposition, "retain");
    assert.equal(record.destination, record.path);
    await access(path.join(root, record.path));
    await access(path.join(root, record.destination));
  }
  assert.equal(new Set(manifest.records.map(({ path: file }) => file)).size, manifest.records.length);
  assert.deepEqual(manifest.records.find(({ path: file }) => file === "src/ownership/rootOwnershipBoundary.test.ts"), {
    path: "src/ownership/rootOwnershipBoundary.test.ts", owner: "B106", disposition: "retain", destination: "src/ownership/rootOwnershipBoundary.test.ts"
  });
  const all = await files(sourceRoot);
  const relative = (file: string) => path.relative(root, file).split(path.sep).join("/");
  const matches = await Promise.all(all.map(async (file) => ({ file: relative(file), source: await readFile(file, "utf8") })));
  const actual = matches.filter(({ file, source }) => footballToken.test(file) || footballToken.test(source)).map(({ file }) => file).sort();
  assert.deepEqual(actual, manifest.records.map(({ path: file }) => file).sort());
  assert.deepEqual(matches.filter(({ file, source }) => !file.endsWith(".test.ts") && (footballToken.test(file) || footballToken.test(source))).map(({ file }) => file), manifest.production_implementation_paths);
});
