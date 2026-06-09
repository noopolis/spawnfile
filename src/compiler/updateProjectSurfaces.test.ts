import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { readUtf8File, removeDirectory } from "../filesystem/index.js";
import { loadManifest } from "../manifest/index.js";

import { addAgentProject, addSubagentProject } from "./addProjectNode.js";
import { initProject } from "./initProject.js";
import {
  addProjectSurface,
  removeProjectSurface,
  setProjectSurfaceAccess,
  showProjectSurfaces
} from "./updateProjectSurfaces.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("addProjectSurface", () => {
  it("adds a surface block and preserves canonical render order", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-surface-add-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, runtime: "openclaw" });

    const manifestPath = path.join(directory, "Spawnfile");
    const result = await addProjectSurface({
      path: directory,
      surface: "discord"
    });

    const nextSource = await readUtf8File(manifestPath);
    const nextManifest = await loadManifest(manifestPath);

    expect(result.updatedFiles).toEqual([manifestPath]);
    expect(nextSource).toContain("surfaces:\n  discord: {}");
    expect(nextSource.indexOf("docs:")).toBeLessThan(nextSource.indexOf("surfaces:"));
    expect(nextManifest.manifest.kind).toBe("agent");
    if (nextManifest.manifest.kind !== "agent") {
      throw new Error("expected agent manifest");
    }
    expect(nextManifest.manifest.surfaces?.discord).toEqual({});
  });

  it("rejects the removed portable http surface", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-surface-add-http-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, runtime: "openclaw" });

    await expect(
      addProjectSurface({
        path: directory,
        surface: "http"
      })
    ).rejects.toThrow(/unsupported portable surface http/i);
  });

  it("updates a whole team graph recursively", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-surface-add-recursive-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, team: true });
    await addAgentProject({ id: "writer", path: directory });
    await addSubagentProject({ id: "critic", path: path.join(directory, "agents", "writer") });

    const result = await addProjectSurface({
      path: directory,
      recursive: true,
      surface: "telegram"
    });

    expect(result.updatedFiles).toEqual([
      path.join(directory, "agents", "writer", "Spawnfile"),
      path.join(directory, "agents", "writer", "subagents", "critic", "Spawnfile")
    ]);

    const rootManifest = await loadManifest(path.join(directory, "Spawnfile"));
    const writerManifest = await loadManifest(path.join(directory, "agents", "writer", "Spawnfile"));
    const criticManifest = await loadManifest(
      path.join(directory, "agents", "writer", "subagents", "critic", "Spawnfile")
    );

    expect(rootManifest.manifest.kind).toBe("team");
    expect(rootManifest.manifest.surfaces).toBeUndefined();
    expect(writerManifest.manifest.kind).toBe("agent");
    if (writerManifest.manifest.kind !== "agent" || criticManifest.manifest.kind !== "agent") {
      throw new Error("expected agent manifests");
    }
    expect(writerManifest.manifest.surfaces?.telegram).toEqual({});
    expect(criticManifest.manifest.surfaces?.telegram).toEqual({});
  });

  it("rejects non-recursive surface updates on team manifests", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-surface-team-error-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, team: true });

    await expect(
      addProjectSurface({
        path: directory,
        surface: "discord"
      })
    ).rejects.toThrow(/use --recursive to update descendant agents of a team project/);
  });
});

describe("setProjectSurfaceAccess", () => {
  it("sets explicit allowlist access on an existing surface", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-surface-access-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, runtime: "openclaw" });
    await addProjectSurface({ path: directory, surface: "discord" });

    const manifestPath = path.join(directory, "Spawnfile");
    const result = await setProjectSurfaceAccess({
      channels: ["C2", "C1"],
      guilds: ["G1"],
      mode: "allowlist",
      path: directory,
      surface: "discord",
      users: ["U2", "U1", "U1"]
    });

    const nextSource = await readUtf8File(manifestPath);

    expect(result.updatedFiles).toEqual([manifestPath]);
    expect(nextSource).toContain("      mode: allowlist");
    expect(nextSource).toContain("      users:\n        - U1\n        - U2");
    expect(nextSource).toContain("      guilds:\n        - G1");
    expect(nextSource).toContain("      channels:\n        - C1\n        - C2");
  });

  it("rejects access updates for the removed portable http surface", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-surface-access-http-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, runtime: "openclaw" });

    await expect(
      setProjectSurfaceAccess({
        mode: "open",
        path: directory,
        surface: "http"
      })
    ).rejects.toThrow(/unsupported portable surface http/i);
  });

  it("skips missing surfaces during recursive access updates", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-surface-access-skip-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, team: true });
    await addAgentProject({ id: "writer", path: directory });
    await addAgentProject({ id: "reviewer", path: directory, runtime: "picoclaw" });
    await addProjectSurface({ path: path.join(directory, "agents", "writer"), surface: "telegram" });

    const result = await setProjectSurfaceAccess({
      chats: ["-10042"],
      mode: "allowlist",
      path: directory,
      recursive: true,
      surface: "telegram"
    });

    expect(result.updatedFiles).toEqual([path.join(directory, "agents", "writer", "Spawnfile")]);
  });
});

describe("removeProjectSurface", () => {
  it("removes the surface block and clears surfaces entirely when empty", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-surface-remove-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, runtime: "openclaw" });
    await addProjectSurface({ path: directory, surface: "discord" });

    const manifestPath = path.join(directory, "Spawnfile");
    const result = await removeProjectSurface({
      path: directory,
      surface: "discord"
    });

    const nextSource = await readUtf8File(manifestPath);

    expect(result.updatedFiles).toEqual([manifestPath]);
    expect(nextSource).not.toContain("surfaces:");
  });
});

describe("showProjectSurfaces", () => {
  it("shows recursive agent entries for team graphs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-surface-show-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, team: true });
    await addAgentProject({ id: "writer", path: directory });
    await addProjectSurface({ path: path.join(directory, "agents", "writer"), surface: "slack" });

    const result = await showProjectSurfaces({
      path: directory,
      recursive: true
    });

    expect(result.entries).toEqual([
      {
        kind: "agent",
        manifestPath: path.join(directory, "agents", "writer", "Spawnfile"),
        name: "my-agent",
        surfaces: {
          slack: {}
        }
      }
    ]);
  });
});
