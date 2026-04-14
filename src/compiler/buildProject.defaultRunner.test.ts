import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { removeDirectory } from "../filesystem/index.js";

const temporaryDirectories: string[] = [];
const fixturesRoot = path.resolve(process.cwd(), "fixtures");

const createFakeChild = (): EventEmitter => new EventEmitter();

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
  vi.resetModules();
  vi.doUnmock("node:child_process");
});

describe("buildProject default runner", () => {
  it("falls back to runDockerBuild when no buildRunner is provided", async () => {
    const child = createFakeChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => {
        child.emit("exit", 0, null);
      });
      return child;
    });
    const execFile = vi.fn();
    vi.doMock("node:child_process", () => ({ execFile, spawn }));

    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-build-default-"));
    temporaryDirectories.push(outputDirectory);

    const { buildProject } = await import("./buildProject.js");
    const result = await buildProject(path.join(fixturesRoot, "single-agent"), {
      dockerCommand: "podman",
      outputDirectory
    });

    expect(result.imageTag).toBe("spawnfile-single-agent");
    expect(spawn).toHaveBeenCalledWith("podman", ["build", "-t", "spawnfile-single-agent", "."], {
      cwd: outputDirectory,
      stdio: "inherit"
    });
  }, 30000);
});
