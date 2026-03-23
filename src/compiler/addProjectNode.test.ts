import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureDirectory,
  fileExists,
  readUtf8File,
  removeDirectory,
  writeUtf8File
} from "../filesystem/index.js";
import { isAgentManifest, isTeamManifest, loadManifest } from "../manifest/index.js";

import {
  addAgentProject,
  addSubagentProject,
  addTeamProject
} from "./addProjectNode.js";
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

describe("addAgentProject", () => {
  it("adds an agent member to a team project using the init default runtime", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-add-agent-default-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, team: true });

    const result = await addAgentProject({
      id: "writer",
      path: directory
    });

    const teamManifest = await loadManifest(path.join(directory, "Spawnfile"));
    const childManifest = await loadManifest(path.join(directory, "agents", "writer", "Spawnfile"));
    const parentSource = await readUtf8File(path.join(directory, "Spawnfile"));

    expect(result.updatedFiles).toEqual([path.join(directory, "Spawnfile")]);
    expect(result.createdFiles).toContain(path.join(directory, "agents", "writer", "Spawnfile"));
    expect(isTeamManifest(teamManifest.manifest)).toBe(true);
    if (!isTeamManifest(teamManifest.manifest)) {
      throw new Error("expected team manifest");
    }
    expect(teamManifest.manifest.members).toContainEqual({
      id: "writer",
      ref: "./agents/writer"
    });
    expect(parentSource.indexOf("docs:")).toBeLessThan(parentSource.indexOf("members:"));
    expect(getRuntimeName(childManifest.manifest.runtime)).toBe("openclaw");
    await expect(fileExists(path.join(directory, "agents", "writer", "AGENTS.md"))).resolves.toBe(
      true
    );
  });

  it("adds an agent member to a team project with an explicit runtime override", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-add-agent-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, team: true });

    const result = await addAgentProject({
      id: "writer",
      path: directory,
      runtime: "picoclaw"
    });

    const teamManifest = await loadManifest(path.join(directory, "Spawnfile"));
    const childManifest = await loadManifest(path.join(directory, "agents", "writer", "Spawnfile"));
    const parentSource = await readUtf8File(path.join(directory, "Spawnfile"));

    expect(result.updatedFiles).toEqual([path.join(directory, "Spawnfile")]);
    expect(result.createdFiles).toContain(path.join(directory, "agents", "writer", "Spawnfile"));
    expect(isTeamManifest(teamManifest.manifest)).toBe(true);
    if (!isTeamManifest(teamManifest.manifest)) {
      throw new Error("expected team manifest");
    }
    expect(teamManifest.manifest.members).toContainEqual({
      id: "writer",
      ref: "./agents/writer"
    });
    expect(parentSource.indexOf("docs:")).toBeLessThan(parentSource.indexOf("members:"));
    expect(getRuntimeName(childManifest.manifest.runtime)).toBe("picoclaw");
    await expect(fileExists(path.join(directory, "agents", "writer", "AGENTS.md"))).resolves.toBe(
      true
    );
  });

  it("rejects agent addition outside of a team project", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-add-agent-invalid-"));
    temporaryDirectories.push(directory);

    await initProject({ directory });

    await expect(
      addAgentProject({
        id: "writer",
        path: directory
      })
    ).rejects.toThrow(/only works on team projects/);
  });

  it("rejects invalid child ids and existing child directories", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-add-agent-guards-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, team: true });
    await ensureDirectory(path.join(directory, "agents", "writer"));

    await expect(
      addAgentProject({
        id: "bad writer",
        path: directory
      })
    ).rejects.toThrow(/must not contain whitespace/);

    await expect(
      addAgentProject({
        id: "writer",
        path: directory
      })
    ).rejects.toThrow(/Refusing to overwrite existing child directory/);
  });
});

describe("addSubagentProject", () => {
  it("adds a subagent and inherits the parent runtime", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-add-subagent-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, runtime: "tinyclaw" });

    const result = await addSubagentProject({
      id: "critic",
      path: path.join(directory, "Spawnfile")
    });

    const parentManifest = await loadManifest(path.join(directory, "Spawnfile"));
    const childManifest = await loadManifest(
      path.join(directory, "subagents", "critic", "Spawnfile")
    );
    const parentSource = await readUtf8File(path.join(directory, "Spawnfile"));

    expect(result.updatedFiles).toEqual([path.join(directory, "Spawnfile")]);
    expect(isAgentManifest(parentManifest.manifest)).toBe(true);
    if (!isAgentManifest(parentManifest.manifest)) {
      throw new Error("expected agent manifest");
    }
    expect(parentManifest.manifest.subagents).toContainEqual({
      id: "critic",
      ref: "./subagents/critic"
    });
    expect(parentSource.indexOf("runtime: tinyclaw")).toBeLessThan(parentSource.indexOf("execution:"));
    expect(parentSource.indexOf("execution:")).toBeLessThan(parentSource.indexOf("docs:"));
    expect(parentSource.indexOf("docs:")).toBeLessThan(parentSource.indexOf("subagents:"));
    expect(getRuntimeName(childManifest.manifest.runtime)).toBe("tinyclaw");
    expect(childManifest.manifest.execution?.model?.auth?.method).toBe("claude-code");
  });

  it("rejects subagent addition outside of an agent project", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-add-subagent-invalid-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, team: true });

    await expect(
      addSubagentProject({
        id: "critic",
        path: directory
      })
    ).rejects.toThrow(/only works on agent projects/);
  });

  it("rejects invalid child ids and parents without a runtime", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-add-subagent-guards-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(directory);
    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Agent\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: no-runtime",
        "docs:",
        "  system: AGENTS.md"
      ].join("\n") + "\n"
    );

    await expect(
      addSubagentProject({
        id: "critic/worker",
        path: directory
      })
    ).rejects.toThrow(/must not contain path separators/);

    await expect(
      addSubagentProject({
        id: "critic",
        path: directory
      })
    ).rejects.toThrow(/must declare a runtime before adding subagents/);
  });
});

describe("addTeamProject", () => {
  it("adds a nested team to a team project", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-add-team-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, team: true });

    const result = await addTeamProject({
      id: "platform",
      path: directory
    });

    const parentManifest = await loadManifest(path.join(directory, "Spawnfile"));
    const childManifest = await loadManifest(path.join(directory, "teams", "platform", "Spawnfile"));

    expect(result.updatedFiles).toEqual([path.join(directory, "Spawnfile")]);
    expect(isTeamManifest(parentManifest.manifest)).toBe(true);
    if (!isTeamManifest(parentManifest.manifest)) {
      throw new Error("expected team manifest");
    }
    expect(parentManifest.manifest.members).toContainEqual({
      id: "platform",
      ref: "./teams/platform"
    });
    expect(childManifest.manifest.kind).toBe("team");
    await expect(fileExists(path.join(directory, "teams", "platform", "TEAM.md"))).resolves.toBe(
      true
    );
  });

  it("rejects duplicate child ids", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-add-team-duplicate-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, team: true });
    await addTeamProject({ id: "platform", path: directory });

    await expect(addTeamProject({ id: "platform", path: directory })).rejects.toThrow(
      /Duplicate member id/
    );
  });

  it("rejects invalid ids and non-team parents", async () => {
    const teamDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-add-team-guards-"));
    const agentDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-add-team-invalid-"));
    temporaryDirectories.push(teamDirectory, agentDirectory);

    await initProject({ directory: teamDirectory, team: true });
    await initProject({ directory: agentDirectory });

    await expect(addTeamProject({ id: " ", path: teamDirectory })).rejects.toThrow(
      /must not be empty/
    );

    await expect(addTeamProject({ id: "platform", path: agentDirectory })).rejects.toThrow(
      /only works on team projects/
    );
  });
});
