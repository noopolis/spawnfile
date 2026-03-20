import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { fileExists, removeDirectory } from "../filesystem/index.js";

import { runCli } from "./runCli.js";

const temporaryDirectories: string[] = [];
const fixturesRoot = path.resolve(process.cwd(), "fixtures");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("runCli", () => {
  it("lists runtime adapters", async () => {
    const stdout: string[] = [];
    const exitCode = await runCli(["runtimes"], {
      stderr: () => undefined,
      stdout: (message) => stdout.push(message)
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("openclaw");
  });

  it("validates a project", async () => {
    const stdout: string[] = [];
    const exitCode = await runCli(["validate", path.join(fixturesRoot, "single-agent")], {
      stderr: () => undefined,
      stdout: (message) => stdout.push(message)
    });

    expect(exitCode).toBe(0);
    expect(stdout[0]).toBe("validation succeeded");
  });

  it("compiles a project", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-cli-"));
    temporaryDirectories.push(outputDirectory);

    const stdout: string[] = [];
    const exitCode = await runCli(
      ["compile", path.join(fixturesRoot, "single-agent"), "--out", outputDirectory],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message)
      }
    );

    expect(exitCode).toBe(0);
    expect(stdout[0]).toContain("compiled to");
  });

  it("initializes a team project", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-cli-init-"));
    temporaryDirectories.push(directory);

    const stdout: string[] = [];
    const exitCode = await runCli(["init", directory, "--team"], {
      stderr: () => undefined,
      stdout: (message) => stdout.push(message)
    });

    expect(exitCode).toBe(0);
    await expect(fileExists(path.join(directory, "TEAM.md"))).resolves.toBe(true);
    expect(stdout[0]).toContain("initialized");
  });

  it("returns a non-zero exit code on errors", async () => {
    const stderr: string[] = [];
    const exitCode = await runCli(["validate", path.join(fixturesRoot, "does-not-exist")], {
      stderr: (message) => stderr.push(message),
      stdout: () => undefined
    });

    expect(exitCode).toBe(1);
    expect(stderr[0]).toBeTruthy();
  });

  it("uses default process streams when custom streams are not provided", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      const exitCode = await runCli(["runtimes"]);

      expect(exitCode).toBe(0);
      expect(stdoutSpy).toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("prints commander errors through the default stderr stream", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const exitCode = await runCli(["unknown-command"]);

      expect(exitCode).toBe(1);
      expect(stderrSpy).toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
