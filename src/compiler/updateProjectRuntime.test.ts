import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { readUtf8File, removeDirectory, writeUtf8File } from "../filesystem/index.js";
import { isTeamManifest, loadManifest } from "../manifest/index.js";

import { addAgentProject, addSubagentProject } from "./addProjectNode.js";
import { initProject } from "./initProject.js";
import { setProjectRuntime } from "./updateProjectRuntime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("setProjectRuntime", () => {
  it("sets an agent runtime", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-runtime-set-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, runtime: "openclaw" });

    const manifestPath = path.join(directory, "Spawnfile");
    const result = await setProjectRuntime({
      path: directory,
      runtime: "picoclaw"
    });

    const nextSource = await readUtf8File(manifestPath);

    expect(result.updatedFiles).toEqual([manifestPath]);
    expect(nextSource).toContain("runtime: picoclaw");
    expect(nextSource).not.toContain("runtime: openclaw");
  });

  it("updates descendant agents recursively and leaves team manifests untouched", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-runtime-set-recursive-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, team: true });
    await addAgentProject({ id: "writer", path: directory, runtime: "openclaw" });
    await addSubagentProject({ id: "critic", path: path.join(directory, "agents", "writer") });

    const result = await setProjectRuntime({
      path: directory,
      recursive: true,
      runtime: "picoclaw"
    });

    const rootManifest = await loadManifest(path.join(directory, "Spawnfile"));
    const writerManifest = await loadManifest(path.join(directory, "agents", "writer", "Spawnfile"));
    const criticManifest = await loadManifest(
      path.join(directory, "agents", "writer", "subagents", "critic", "Spawnfile")
    );

    expect(result.updatedFiles).toEqual([
      path.join(directory, "agents", "writer", "Spawnfile"),
      path.join(directory, "agents", "writer", "subagents", "critic", "Spawnfile")
    ]);
    expect(isTeamManifest(rootManifest.manifest)).toBe(true);
    expect(writerManifest.manifest.runtime).toBe("picoclaw");
    expect(criticManifest.manifest.runtime).toBe("picoclaw");
  });

  it("rejects non-recursive runtime updates on team manifests", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-runtime-team-error-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, team: true });

    await expect(
      setProjectRuntime({
        path: directory,
        runtime: "picoclaw"
      })
    ).rejects.toThrow(/use --recursive to update descendant agents of a team project/);
  });

  it("rejects unknown runtime bindings", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-runtime-unknown-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, runtime: "openclaw" });

    await expect(
      setProjectRuntime({
        path: directory,
        runtime: "ghostclaw"
      })
    ).rejects.toThrow(/Unknown runtime binding: ghostclaw/);
  });

  it("validates target runtime model compatibility before rewriting", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-runtime-model-guard-"));
    temporaryDirectories.push(directory);

    const manifestPath = path.join(directory, "Spawnfile");
    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Agent\n");
    await writeUtf8File(
      manifestPath,
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: guarded-agent",
        "",
        "runtime: openclaw",
        "",
        "execution:",
        "  model:",
        "    primary:",
        "      provider: openai",
        "      name: gpt-4o",
        "      auth:",
        "        method: api_key",
        "",
        "docs:",
        "  system: AGENTS.md",
        ""
      ].join("\n")
    );

    await expect(
      setProjectRuntime({
        path: directory,
        runtime: "tinyclaw"
      })
    ).rejects.toThrow(/TinyClaw does not support model auth method api_key for provider openai/);
  });
});
