import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXPORT_INDEX_PATH, publishArtifactFiles, resolveArtifactOutputPaths } from "./artifactExportPublication.js";
import { EXPORT_INDEX_VERSION, type ExportIndex } from "./artifactsExportTypes.js";

describe("artifact export publication", () => {
  let root: string;
  let destination: string;
  let staging: string;
  const index = (names: string[]): ExportIndex => ({
    deployment: "example", exported_at: "2026-05-01T00:00:00Z",
    files: names.map((name) => ({
      bytes: 3, path: name, sha256: "0".repeat(64), source: { kind: "container", ref: "example" }
    })),
    run_id: "sample", version: EXPORT_INDEX_VERSION
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-export-publication-"));
    destination = path.join(root, "destination");
    staging = path.join(root, "staging");
    await mkdir(path.join(staging, "raw"), { recursive: true });
    await mkdir(path.join(destination, "raw"), { recursive: true });
    await mkdir(path.join(destination, "spawnfile"));
  });
  afterEach(() => rm(root, { force: true, recursive: true }));

  it("restores the preceding bytes and index when a later staged file disappears", async () => {
    await writeFile(path.join(destination, "raw/one"), "old");
    await writeFile(path.join(destination, EXPORT_INDEX_PATH), "previous index");
    await writeFile(path.join(staging, "raw/one"), "new");
    await writeFile(path.join(staging, "raw/two"), "new");

    await expect(publishArtifactFiles(destination, staging, index(["raw/one", "raw/two", "raw/missing"])))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(destination, "raw/one"), "utf8")).resolves.toBe("old");
    await expect(readFile(path.join(destination, "raw/two"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(destination, EXPORT_INDEX_PATH), "utf8")).resolves.toBe("previous index");
  });

  it.each([
    ["raw/data", "raw/data"],
    ["private/sample", "private/sample/transcript"],
    [EXPORT_INDEX_PATH],
    ["spawnfile/.export.lock"],
    [".spawnfile-export-example/file"]
  ])("rejects overlapping or reserved output declarations before publication", async (...paths) => {
    await expect(resolveArtifactOutputPaths(staging, paths)).rejects.toThrow();
  });
});
