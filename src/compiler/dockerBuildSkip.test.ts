import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BUILD_IMAGE_CACHE_VERSION,
  type BuildImageCacheEntry
} from "../deployment/buildImageCacheStore.js";

import {
  createDockerImageInspector,
  DOCKER_IMAGE_INSPECT_MAX_OUTPUT_BYTES,
  DOCKER_IMAGE_INSPECT_TIMEOUT_MS,
  shouldSkipDockerBuild,
  type DockerBuildSkipInput,
  type DockerImageInspector
} from "./dockerBuildSkip.js";

const fingerprint = "sf1:abc123";
const contextDigest = `sha256:${"a".repeat(64)}`;

const createEntry = (
  overrides: Partial<BuildImageCacheEntry> = {}
): BuildImageCacheEntry => ({
  compileFingerprint: fingerprint,
  contextDigest,
  dockerContext: null,
  imageId: "sha256:image-id",
  imageTag: "spawnfile-project",
  projectRoot: "/tmp/project/Spawnfile",
  version: BUILD_IMAGE_CACHE_VERSION,
  writtenAt: "2026-07-30T12:00:00.000Z",
  ...overrides
});

const createInput = (
  cacheEntry: BuildImageCacheEntry | null,
  imageInspector: DockerImageInspector,
  overrides: Partial<DockerBuildSkipInput> = {}
): DockerBuildSkipInput => ({
  cacheEntry,
  compileFingerprint: fingerprint,
  contextDigest,
  dockerContext: null,
  imageInspector,
  imageTag: "spawnfile-project",
  ...overrides
});

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

describe("Docker build skip decision", () => {
  it("short-circuits before inspection for cold and mismatched cache entries", async () => {
    const inspector = vi.fn<DockerImageInspector>();
    const cases: DockerBuildSkipInput[] = [
      createInput(null, inspector),
      createInput(createEntry({ contextDigest: `sha256:${"b".repeat(64)}` }), inspector),
      createInput(createEntry({ imageTag: "other" }), inspector),
      createInput(createEntry({ compileFingerprint: "sf1:other" }), inspector),
      createInput(createEntry({ dockerContext: "remote" }), inspector)
    ];

    for (const input of cases) {
      await expect(shouldSkipDockerBuild(input)).resolves.toBe(false);
    }
    expect(inspector).not.toHaveBeenCalled();
  });

  it("skips only when the local tag id and compile-fingerprint label match", async () => {
    const inspector = vi.fn(async () => ({
      id: "sha256:image-id",
      labels: { "com.spawnfile.compile_fingerprint": fingerprint }
    }));

    await expect(
      shouldSkipDockerBuild(createInput(createEntry(), inspector))
    ).resolves.toBe(true);
    expect(inspector).toHaveBeenCalledWith(expect.objectContaining({
      dockerContext: null,
      imageTag: "spawnfile-project"
    }));
  });

  it("treats missing images, identity drift, malformed labels, and inspector errors as misses", async () => {
    const inspectors: DockerImageInspector[] = [
      async () => null,
      async () => ({ id: "sha256:other", labels: {
        "com.spawnfile.compile_fingerprint": fingerprint
      } }),
      async () => ({ id: "sha256:image-id", labels: {
        "com.spawnfile.compile_fingerprint": "sf1:other"
      } }),
      async () => {
        throw new Error("probe failed");
      }
    ];

    for (const inspector of inspectors) {
      await expect(
        shouldSkipDockerBuild(createInput(createEntry(), inspector))
      ).resolves.toBe(false);
    }
  });
});

describe("Docker image inspector", () => {
  it("uses the default bounded command runner without executing a real Docker binary", async () => {
    const stdout = JSON.stringify({
      id: "sha256:image-id",
      labels: { "com.spawnfile.compile_fingerprint": fingerprint }
    });
    const execFile = vi.fn((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error | null,
        stdout: string
      ) => void;
      callback(null, stdout);
    });
    vi.doMock("node:child_process", () => ({ execFile }));
    vi.resetModules();
    const { createDockerImageInspector: createDefaultInspector } =
      await import("./dockerBuildSkip.js");
    const inspector = createDefaultInspector();

    await expect(inspector({
      dockerCommand: "podman",
      imageTag: "spawnfile-project"
    })).resolves.toEqual({
      id: "sha256:image-id",
      labels: { "com.spawnfile.compile_fingerprint": fingerprint }
    });
    expect(execFile).toHaveBeenCalledWith(
      "podman",
      ["image", "inspect", "spawnfile-project", "--format", expect.any(String)],
      expect.objectContaining({
        maxBuffer: DOCKER_IMAGE_INSPECT_MAX_OUTPUT_BYTES,
        timeout: DOCKER_IMAGE_INSPECT_TIMEOUT_MS
      }),
      expect.any(Function)
    );

    execFile.mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error | null,
        stdout: string
      ) => void;
      callback(new Error("image absent"), "");
    });
    await expect(inspector({ imageTag: "missing" })).resolves.toBeNull();
  });

  it("uses a bounded context-aware image inspect command and parses id plus labels", async () => {
    const runner = vi.fn(async () => ({
      stdout: JSON.stringify({
        id: "sha256:image-id",
        labels: { "com.spawnfile.compile_fingerprint": fingerprint }
      })
    }));
    const inspector = createDockerImageInspector(runner);

    await expect(inspector({
      dockerCommand: "podman",
      dockerContext: "remote",
      imageTag: "spawnfile-project"
    })).resolves.toEqual({
      id: "sha256:image-id",
      labels: { "com.spawnfile.compile_fingerprint": fingerprint }
    });
    expect(runner).toHaveBeenCalledWith(
      "podman",
      [
        "--context",
        "remote",
        "image",
        "inspect",
        "spawnfile-project",
        "--format",
        '{"id":{{json .Id}},"labels":{{json .Config.Labels}}}'
      ],
      {
        encoding: "utf8",
        maxBuffer: DOCKER_IMAGE_INSPECT_MAX_OUTPUT_BYTES,
        timeout: DOCKER_IMAGE_INSPECT_TIMEOUT_MS
      }
    );
  });

  it("returns misses for absent labels, bad output, oversized output, and command errors", async () => {
    const outputs: Array<() => Promise<{ stdout: string }>> = [
      async () => ({ stdout: JSON.stringify({ id: "sha256:image-id", labels: null }) }),
      async () => ({ stdout: JSON.stringify({ id: "", labels: {} }) }),
      async () => ({ stdout: JSON.stringify({ id: "sha256:image-id", labels: [] }) }),
      async () => ({ stdout: "{bad-json" }),
      async () => ({ stdout: "x".repeat(DOCKER_IMAGE_INSPECT_MAX_OUTPUT_BYTES + 1) }),
      async () => {
        throw new Error("image absent");
      }
    ];

    const results = [];
    for (const output of outputs) {
      results.push(await createDockerImageInspector(output)({
        imageTag: "spawnfile-project"
      }));
    }

    expect(results).toEqual([
      { id: "sha256:image-id", labels: {} },
      null,
      null,
      null,
      null,
      null
    ]);
  });

  it("rejects non-string label values", async () => {
    const inspector = createDockerImageInspector(async () => ({
      stdout: JSON.stringify({
        id: "sha256:image-id",
        labels: { "com.spawnfile.compile_fingerprint": 42 }
      })
    }));
    await expect(inspector({ imageTag: "spawnfile-project" })).resolves.toBeNull();
  });
});
