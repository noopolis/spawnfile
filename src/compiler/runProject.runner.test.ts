import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const createFakeChild = (): EventEmitter => new EventEmitter();

const loadRunProjectModule = async (child: EventEmitter) => {
  const spawn = vi.fn(() => child);
  vi.doMock("node:child_process", () => ({ spawn }));

  const module = await import("./runProject.js");
  return { ...module, spawn };
};

describe("runDockerContainer", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("node:child_process");
  });

  it("runs docker run in the compile output directory", async () => {
    const child = createFakeChild();
    const { runDockerContainer, spawn } = await loadRunProjectModule(child);

    const promise = runDockerContainer({
      args: ["run", "--rm", "--name", "spawnfile-agent", "spawnfile-agent"],
      command: "docker",
      containerName: "spawnfile-agent",
      cwd: "/tmp/spawnfile-run",
      detach: false,
      envFilePath: "/tmp/spawnfile-run.env",
      imageTag: "spawnfile-agent",
      supportDirectory: "/tmp/spawnfile-run"
    });
    child.emit("exit", 0, null);

    await expect(promise).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledWith(
      "docker",
      ["run", "--rm", "--name", "spawnfile-agent", "spawnfile-agent"],
      {
        cwd: "/tmp/spawnfile-run",
        stdio: "inherit"
      }
    );
  });

  it("wraps command start failures as runtime errors", async () => {
    const child = createFakeChild();
    const { runDockerContainer } = await loadRunProjectModule(child);

    const promise = runDockerContainer({
      args: ["run", "--rm", "spawnfile-agent"],
      command: "docker",
      containerName: null,
      cwd: "/tmp/spawnfile-run",
      detach: false,
      envFilePath: "/tmp/spawnfile-run.env",
      imageTag: "spawnfile-agent",
      supportDirectory: "/tmp/spawnfile-run"
    });
    child.emit("error", new Error("spawn docker ENOENT"));

    await expect(promise).rejects.toMatchObject({
      code: "runtime_error",
      message: "Unable to start docker run for spawnfile-agent: spawn docker ENOENT"
    });
  });

  it("wraps non-zero exits and signals as runtime errors", async () => {
    const failingChild = createFakeChild();
    const signalChild = createFakeChild();
    const firstModule = await loadRunProjectModule(failingChild);

    const failingPromise = firstModule.runDockerContainer({
      args: ["run", "--rm", "spawnfile-agent"],
      command: "docker",
      containerName: null,
      cwd: "/tmp/spawnfile-run",
      detach: false,
      envFilePath: "/tmp/spawnfile-run.env",
      imageTag: "spawnfile-agent",
      supportDirectory: "/tmp/spawnfile-run"
    });
    failingChild.emit("exit", 1, null);

    await expect(failingPromise).rejects.toMatchObject({
      code: "runtime_error",
      message: "Docker run for spawnfile-agent failed with exit code 1"
    });

    vi.resetModules();
    vi.doUnmock("node:child_process");

    const secondModule = await loadRunProjectModule(signalChild);
    const signaledPromise = secondModule.runDockerContainer({
      args: ["run", "--rm", "spawnfile-agent"],
      command: "docker",
      containerName: null,
      cwd: "/tmp/spawnfile-run",
      detach: false,
      envFilePath: "/tmp/spawnfile-run.env",
      imageTag: "spawnfile-agent",
      supportDirectory: "/tmp/spawnfile-run"
    });
    signalChild.emit("exit", null, "SIGTERM");

    await expect(signaledPromise).rejects.toMatchObject({
      code: "runtime_error",
      message: "Docker run for spawnfile-agent exited from signal SIGTERM"
    });
  });
});
