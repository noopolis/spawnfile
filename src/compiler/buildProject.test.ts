import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { fileExists, readUtf8File, removeDirectory } from "../filesystem/index.js";

import {
  buildProject,
  createDefaultImageTag,
  createDockerBuildInvocation,
  type DockerBuildInvocation
} from "./buildProject.js";

const temporaryDirectories: string[] = [];
const fixturesRoot = path.resolve(process.cwd(), "fixtures");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("buildProject", () => {
  it("builds a single-agent project with a default image tag", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-build-single-"));
    temporaryDirectories.push(outputDirectory);

    const invocations: DockerBuildInvocation[] = [];
    const result = await buildProject(path.join(fixturesRoot, "single-agent"), {
      buildRunner: async (invocation) => {
        invocations.push(invocation);
      },
      outputDirectory
    });

    expect(result.imageTag).toBe("spawnfile-single-agent");
    expect(invocations).toEqual([
      {
        args: ["build", "-t", "spawnfile-single-agent", "."],
        command: "docker",
        cwd: outputDirectory,
        imageTag: "spawnfile-single-agent"
      }
    ]);
    await expect(fileExists(path.join(outputDirectory, "Dockerfile"))).resolves.toBe(true);
    await expect(fileExists(path.join(outputDirectory, "runtime-sources"))).resolves.toBe(false);

    const dockerfile = await readUtf8File(path.join(outputDirectory, "Dockerfile"));
    expect(dockerfile).toContain(
      "RUN npm install -g --omit=dev --no-fund --no-audit openclaw@2026.3.13"
    );
    expect(dockerfile).not.toContain("runtime-sources");
  }, 30000);

  it("builds a multi-runtime team with artifact installs for all runtimes", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-build-team-"));
    temporaryDirectories.push(outputDirectory);

    const buildRunner = vi.fn(async () => undefined);
    const result = await buildProject(path.join(fixturesRoot, "multi-runtime-team"), {
      buildRunner,
      outputDirectory
    });

    expect(result.imageTag).toBe("spawnfile-multi-runtime-team");
    expect(buildRunner).toHaveBeenCalledWith({
      args: ["build", "-t", "spawnfile-multi-runtime-team", "."],
      command: "docker",
      cwd: outputDirectory,
      imageTag: "spawnfile-multi-runtime-team"
    });

    const dockerfile = await readUtf8File(path.join(outputDirectory, "Dockerfile"));
    expect(dockerfile).toContain(
      "RUN npm install -g --omit=dev --no-fund --no-audit openclaw@2026.3.13"
    );
    expect(dockerfile).toContain(
      "https://github.com/sipeed/picoclaw/releases/download/v0.2.3/$asset"
    );
    expect(dockerfile).toContain(
      "https://github.com/TinyAGI/tinyagi/releases/download/v0.0.15/tinyagi-bundle.tar.gz"
    );
    expect(dockerfile).not.toContain("go build -o /usr/local/bin/picoclaw");
    expect(dockerfile).not.toContain("pnpm install");
  }, 30000);

  it("uses an explicit image tag when provided", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-build-tag-"));
    temporaryDirectories.push(outputDirectory);

    const buildRunner = vi.fn(async () => undefined);
    const result = await buildProject(path.join(fixturesRoot, "single-agent"), {
      buildRunner,
      imageTag: "custom-image:dev",
      outputDirectory
    });

    expect(result.imageTag).toBe("custom-image:dev");
    expect(buildRunner).toHaveBeenCalledWith({
      args: ["build", "-t", "custom-image:dev", "."],
      command: "docker",
      cwd: outputDirectory,
      imageTag: "custom-image:dev"
    });
  }, 30000);

  it("derives the default image tag from a Spawnfile file path", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-build-file-"));
    temporaryDirectories.push(outputDirectory);

    const buildRunner = vi.fn(async () => undefined);
    const result = await buildProject(path.join(fixturesRoot, "single-agent", "Spawnfile"), {
      buildRunner,
      outputDirectory
    });

    expect(result.imageTag).toBe("spawnfile-single-agent");
    expect(buildRunner).toHaveBeenCalledWith({
      args: ["build", "-t", "spawnfile-single-agent", "."],
      command: "docker",
      cwd: outputDirectory,
      imageTag: "spawnfile-single-agent"
    });
  }, 30000);
});

describe("buildProject helpers", () => {
  it("creates default image tags from the project root directory", () => {
    expect(createDefaultImageTag("/tmp/Single Agent")).toBe("spawnfile-single-agent");
    expect(createDefaultImageTag("/tmp/???")).toBe("spawnfile-project");
  });

  it("creates docker build invocations for the compile output directory", () => {
    expect(createDockerBuildInvocation("/tmp/dist", "spawnfile-agent")).toEqual({
      args: ["build", "-t", "spawnfile-agent", "."],
      command: "docker",
      cwd: "/tmp/dist",
      imageTag: "spawnfile-agent"
    });
  });
});
