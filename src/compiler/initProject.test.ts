import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  fileExists,
  readUtf8File,
  removeDirectory,
  writeUtf8File
} from "../filesystem/index.js";
import { loadManifest } from "../manifest/index.js";

import { initProject } from "./initProject.js";

const temporaryDirectories: string[] = [];
const getRuntimeName = (runtime: unknown): string | undefined =>
  typeof runtime === "string"
    ? runtime
    : runtime && typeof runtime === "object" && "name" in runtime
      ? String(runtime.name)
      : undefined;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("initProject", () => {
  it("scaffolds an agent project", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-init-"));
    temporaryDirectories.push(directory);

    const result = await initProject({ directory });
    const loadedManifest = await loadManifest(path.join(directory, "Spawnfile"));

    expect(result.createdFiles).toHaveLength(4);
    await expect(fileExists(path.join(directory, "Spawnfile"))).resolves.toBe(true);
    await expect(fileExists(path.join(directory, "IDENTITY.md"))).resolves.toBe(true);
    await expect(fileExists(path.join(directory, "SOUL.md"))).resolves.toBe(true);
    await expect(fileExists(path.join(directory, "AGENTS.md"))).resolves.toBe(true);
    await expect(readUtf8File(path.join(directory, "AGENTS.md"))).resolves.toContain(
      "This folder is home. Treat it that way."
    );
    await expect(readUtf8File(path.join(directory, "SOUL.md"))).resolves.toContain(
      "You're not a chatbot. You're becoming someone."
    );
    await expect(readUtf8File(path.join(directory, "IDENTITY.md"))).resolves.toContain(
      "Fill this in during your first conversation."
    );
    expect(loadedManifest.manifest.kind).toBe("agent");
    expect(getRuntimeName(loadedManifest.manifest.runtime)).toBe("openclaw");
    expect(loadedManifest.manifest.docs).toMatchObject({
      identity: "IDENTITY.md",
      soul: "SOUL.md",
      system: "AGENTS.md"
    });
    expect(loadedManifest.manifest.execution?.model?.primary.name).toBe("claude-opus-4-6");
    expect(loadedManifest.manifest.execution?.model?.primary.provider).toBe("anthropic");
    expect(loadedManifest.manifest.execution?.workspace).toBeUndefined();
    expect(loadedManifest.manifest.execution?.sandbox).toBeUndefined();
  });

  it("scaffolds a PicoClaw agent project when requested", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-picoclaw-init-"));
    temporaryDirectories.push(directory);

    const result = await initProject({ directory, runtime: "picoclaw" });
    const loadedManifest = await loadManifest(path.join(directory, "Spawnfile"));

    expect(result.createdFiles).toHaveLength(4);
    await expect(readUtf8File(path.join(directory, "AGENTS.md"))).resolves.toContain(
      "PicoClaw reads this from the workspace."
    );
    expect(getRuntimeName(loadedManifest.manifest.runtime)).toBe("picoclaw");
    expect(loadedManifest.manifest.execution?.model?.auth).toBeUndefined();
    expect(loadedManifest.manifest.execution?.model?.primary.name).toBe("claude-sonnet-4-6");
    expect(loadedManifest.manifest.execution?.model?.primary.provider).toBe("anthropic");
    expect(loadedManifest.manifest.execution?.workspace).toBeUndefined();
    expect(loadedManifest.manifest.execution?.sandbox).toBeUndefined();
  });

  it("scaffolds a TinyClaw agent project with explicit supported auth", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-tinyclaw-init-"));
    temporaryDirectories.push(directory);

    const result = await initProject({ directory, runtime: "tinyclaw" });
    const loadedManifest = await loadManifest(path.join(directory, "Spawnfile"));

    expect(result.createdFiles).toHaveLength(3);
    expect(getRuntimeName(loadedManifest.manifest.runtime)).toBe("tinyclaw");
    await expect(fileExists(path.join(directory, "IDENTITY.md"))).resolves.toBe(false);
    await expect(readUtf8File(path.join(directory, "AGENTS.md"))).resolves.toContain(
      "TinyAGI - Multi-team Personal Assistants"
    );
    await expect(readUtf8File(path.join(directory, "SOUL.md"))).resolves.toContain(
      "This is your soul file. It defines WHO you are."
    );
    expect(loadedManifest.manifest.execution?.model?.auth?.method).toBe("claude-code");
    expect(loadedManifest.manifest.execution?.model?.primary.name).toBe("claude-sonnet-4-6");
    expect(loadedManifest.manifest.execution?.model?.primary.provider).toBe("anthropic");
    expect(loadedManifest.manifest.docs).toMatchObject({
      soul: "SOUL.md",
      system: "AGENTS.md"
    });
    expect(loadedManifest.manifest.docs?.identity).toBeUndefined();
    expect(loadedManifest.manifest.execution?.workspace).toBeUndefined();
    expect(loadedManifest.manifest.execution?.sandbox).toBeUndefined();
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

  it("rejects runtime selection for team scaffolds", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-team-runtime-init-"));
    temporaryDirectories.push(directory);

    await expect(initProject({ directory, runtime: "tinyclaw", team: true })).rejects.toThrow(
      /do not accept --runtime/
    );
  });

  it("rejects unknown agent runtimes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-unknown-runtime-init-"));
    temporaryDirectories.push(directory);

    await expect(initProject({ directory, runtime: "ghostclaw" })).rejects.toThrow(
      /Unknown runtime adapter/
    );
  });
});
