import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readBuildImageCacheEntry } from "../deployment/buildImageCacheStore.js";
import { readUtf8File, removeDirectory } from "../filesystem/index.js";

const temporaryDirectories: string[] = [];
const fixturesRoot = path.resolve(process.cwd(), "examples");

const createFakeChild = (): EventEmitter => new EventEmitter();

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
  vi.unstubAllEnvs();
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
    const homeDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-build-home-"));
    temporaryDirectories.push(outputDirectory);
    temporaryDirectories.push(homeDirectory);
    vi.stubEnv("SPAWNFILE_HOME", homeDirectory);

    const { buildProject } = await import("./buildProject.js");
    const imageInspector = vi.fn(async () => {
      const report = JSON.parse(
        await readUtf8File(path.join(outputDirectory, "distribution-report.json"))
      ) as { compile_fingerprint: string };
      return {
        id: "sha256:fresh-image",
        labels: {
          "com.spawnfile.compile_fingerprint": report.compile_fingerprint
        }
      };
    });
    const result = await buildProject(path.join(fixturesRoot, "single-agent"), {
      dockerCommand: "podman",
      imageInspector,
      outputDirectory
    });

    expect(result.imageTag).toBe("spawnfile-single-agent");
    expect(result.imageBuild).toEqual(expect.objectContaining({
      buildMs: expect.any(Number),
      contextDigestMs: expect.any(Number),
      skipped: false
    }));
    expect(spawn).toHaveBeenCalledWith("podman", ["build", "-t", "spawnfile-single-agent", "."], {
      cwd: outputDirectory,
      stdio: "inherit"
    });
    expect(imageInspector).toHaveBeenCalledOnce();
    await expect(readBuildImageCacheEntry({
      dockerContext: null,
      imageTag: result.imageTag,
      projectRoot: result.report.root
    })).resolves.toEqual(expect.objectContaining({
      contextDigest: result.imageBuild!.contextDigest,
      imageId: "sha256:fresh-image"
    }));
  }, 30000);
});
