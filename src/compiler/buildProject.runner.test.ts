import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const createFakeChild = (): EventEmitter => new EventEmitter();

const loadBuildProjectModule = async (child: EventEmitter) => {
  const spawn = vi.fn(() => child);
  vi.doMock("node:child_process", () => ({ spawn }));

  const module = await import("./buildProject.js");
  return { ...module, spawn };
};

describe("runDockerBuild", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("node:child_process");
  });

  it("runs docker build in the compile output directory", async () => {
    const child = createFakeChild();
    const { runDockerBuild, spawn } = await loadBuildProjectModule(child);

    const promise = runDockerBuild({
      args: ["build", "-t", "spawnfile-agent", "."],
      command: "docker",
      cwd: "/tmp/spawnfile-build",
      imageTag: "spawnfile-agent"
    });
    child.emit("exit", 0, null);

    await expect(promise).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledWith("docker", ["build", "-t", "spawnfile-agent", "."], {
      cwd: "/tmp/spawnfile-build",
      stdio: "inherit"
    });
  });

  it("wraps command start failures as compile errors", async () => {
    const child = createFakeChild();
    const { runDockerBuild } = await loadBuildProjectModule(child);

    const promise = runDockerBuild({
      args: ["build", "-t", "spawnfile-agent", "."],
      command: "docker",
      cwd: "/tmp/spawnfile-build",
      imageTag: "spawnfile-agent"
    });
    child.emit("error", new Error("spawn docker ENOENT"));

    await expect(promise).rejects.toMatchObject({
      code: "compile_error",
      message: "Unable to start docker build for spawnfile-agent: spawn docker ENOENT"
    });
  });

  it("wraps non-zero exits and signals as compile errors", async () => {
    const failingChild = createFakeChild();
    const signalChild = createFakeChild();
    const firstModule = await loadBuildProjectModule(failingChild);

    const failingPromise = firstModule.runDockerBuild({
      args: ["build", "-t", "spawnfile-agent", "."],
      command: "docker",
      cwd: "/tmp/spawnfile-build",
      imageTag: "spawnfile-agent"
    });
    failingChild.emit("exit", 1, null);

    await expect(failingPromise).rejects.toMatchObject({
      code: "compile_error",
      message: "Docker build for spawnfile-agent failed with exit code 1"
    });

    vi.resetModules();
    vi.doUnmock("node:child_process");

    const secondModule = await loadBuildProjectModule(signalChild);
    const signaledPromise = secondModule.runDockerBuild({
      args: ["build", "-t", "spawnfile-agent", "."],
      command: "docker",
      cwd: "/tmp/spawnfile-build",
      imageTag: "spawnfile-agent"
    });
    signalChild.emit("exit", null, "SIGTERM");

    await expect(signaledPromise).rejects.toMatchObject({
      code: "compile_error",
      message: "Docker build for spawnfile-agent exited from signal SIGTERM"
    });
  });
});
