import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

type FakeChild = EventEmitter & {
  stdout?: EventEmitter & { setEncoding: (encoding: string) => void };
};

const createFakeChild = (): FakeChild => new EventEmitter();

const createFakeDetachedChild = (): FakeChild => {
  const child = createFakeChild();
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  return child;
};

const loadRunProjectModule = async (
  child: FakeChild,
  execFileImplementation: (
    file: string,
    args: string[],
    options: { cwd?: string; timeout?: number },
    callback: (error: Error | null, result: { stderr: string; stdout: string }) => void
  ) => void = (_file, _args, _options, callback) => callback(null, { stderr: "", stdout: "" })
) => {
  const spawn = vi.fn(() => child);
  const execFile = vi.fn(execFileImplementation);
  vi.doMock("node:child_process", () => ({ execFile, spawn }));

  const module = await import("./runProject.js");
  return { ...module, execFile, spawn };
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
      deploymentName: null,
      dockerContext: null,
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
      deploymentName: null,
      dockerContext: null,
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

  it("captures the immutable image id for detached containers", async () => {
    const child = createFakeDetachedChild();
    const { execFile, runDockerContainer, spawn } = await loadRunProjectModule(
      child,
      (_file, _args, _options, callback) => callback(null, {
        stderr: "",
        stdout: "sha256:image-123\n"
      })
    );

    const promise = runDockerContainer({
      args: ["--context", "remote", "run", "-d", "--name", "spawnfile-agent", "spawnfile-agent"],
      command: "docker",
      containerName: "spawnfile-agent",
      cwd: "/tmp/spawnfile-run",
      detach: true,
      deploymentName: "default",
      dockerContext: "remote",
      dockerHost: null,
      envFilePath: "/tmp/spawnfile-run.env",
      imageTag: "spawnfile-agent",
      supportDirectory: "/tmp/spawnfile-run"
    });
    child.stdout?.emit("data", "container-123\n");
    child.emit("exit", 0, null);

    await expect(promise).resolves.toEqual({
      containerId: "container-123",
      imageId: "sha256:image-123"
    });
    expect(spawn).toHaveBeenCalledWith(
      "docker",
      ["--context", "remote", "run", "-d", "--name", "spawnfile-agent", "spawnfile-agent"],
      {
        cwd: "/tmp/spawnfile-run",
        stdio: ["ignore", "pipe", "inherit"]
      }
    );
    expect(execFile).toHaveBeenCalledWith(
      "docker",
      ["--context", "remote", "inspect", "--format", "{{.Image}}", "container-123"],
      { cwd: "/tmp/spawnfile-run", timeout: 10_000 },
      expect.any(Function)
    );
  });

  it("fails detached runs when image id inspection fails", async () => {
    const child = createFakeDetachedChild();
    const { runDockerContainer } = await loadRunProjectModule(
      child,
      (_file, _args, _options, callback) => callback(new Error("inspect failed"), {
        stderr: "",
        stdout: ""
      })
    );

    const promise = runDockerContainer({
      args: ["run", "-d", "spawnfile-agent"],
      command: "docker",
      containerName: "spawnfile-agent",
      cwd: "/tmp/spawnfile-run",
      detach: true,
      deploymentName: "default",
      dockerContext: null,
      dockerHost: null,
      envFilePath: "/tmp/spawnfile-run.env",
      imageTag: "spawnfile-agent",
      supportDirectory: "/tmp/spawnfile-run"
    });
    child.stdout?.emit("data", "container-123\n");
    child.emit("exit", 0, null);

    await expect(promise).rejects.toMatchObject({
      code: "runtime_error",
      message: "Unable to inspect detached container container-123 image id: inspect failed"
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
      deploymentName: null,
      dockerContext: null,
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
      deploymentName: null,
      dockerContext: null,
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
