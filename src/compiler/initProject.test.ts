import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { fileExists, removeDirectory, writeUtf8File } from "../filesystem/index.js";
import { loadManifest } from "../manifest/index.js";

import { initProject } from "./initProject.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("initProject", () => {
  it("scaffolds an agent project", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-init-"));
    temporaryDirectories.push(directory);

    const result = await initProject({ directory });
    const loadedManifest = await loadManifest(path.join(directory, "Spawnfile"));

    expect(result.createdFiles).toHaveLength(2);
    await expect(fileExists(path.join(directory, "Spawnfile"))).resolves.toBe(true);
    expect(loadedManifest.manifest.kind).toBe("agent");
  });

  it("scaffolds a team project", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-team-init-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, team: true });
    const loadedManifest = await loadManifest(path.join(directory, "Spawnfile"));

    await expect(fileExists(path.join(directory, "TEAM.md"))).resolves.toBe(true);
    expect(loadedManifest.manifest.kind).toBe("team");
  });

  it("refuses to overwrite an existing Spawnfile", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-init-existing-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "Spawnfile"), 'spawnfile_version: "0.1"\n');

    await expect(initProject({ directory })).rejects.toThrow(/Refusing to overwrite/);
  });
});
