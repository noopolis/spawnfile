import { EventEmitter } from "node:events";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  createDockerTargetExecutors,
  DockerPublicArtifactNotPresentError,
  PUBLIC_ARTIFACT_READER_PROGRAM,
  type DockerCommandSpawn
} from "./dockerCommandExecutor.js";

const execFile = promisify(execFileCallback);

class Child extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public kill(): boolean { return true; }
}

const executorFor = (
  code: number,
  stderr: string,
  stdout = ""
) => createDockerTargetExecutors({
  spawn: (() => {
    const child = new Child();
    queueMicrotask(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit("close", code);
    });
    return child;
  }) as unknown as DockerCommandSpawn
}).publicArtifact;

const exactProbe = [
  "--context", "local-dev", "container", "exec", "c".repeat(64),
  "/usr/local/bin/node", "--input-type=module", "-e", PUBLIC_ARTIFACT_READER_PROGRAM,
  "spawnfile-public-artifact-read", "/tmp/spawnfile-public/composed-terminal.json"
] as const;

describe("Docker public-artifact command classification", () => {
  it("types only the exact absent declared-path probe", async () => {
    await expect(executorFor(42, "")("docker", exactProbe, { timeout: 100 }))
      .rejects.toBeInstanceOf(DockerPublicArtifactNotPresentError);
  });

  it("keeps nearby provider and safety failures permanent", async () => {
    const nearMisses = [
      { args: exactProbe, code: 2, stderr: "", stdout: "" },
      { args: exactProbe, code: 42, stderr: "permission denied", stdout: "" },
      { args: exactProbe, code: 42, stderr: "", stdout: "unexpected" },
      { args: [...exactProbe.slice(0, 5), "/bin/cat", ...exactProbe.slice(6)], code: 42, stderr: "", stdout: "" },
      { args: [...exactProbe.slice(0, -1), "/tmp/spawnfile-public/../private"], code: 42, stderr: "", stdout: "" },
      { args: [...exactProbe.slice(0, 4), "short-id", ...exactProbe.slice(5)], code: 42, stderr: "", stdout: "" }
    ];
    for (const value of nearMisses) {
      let error: unknown;
      try {
        await executorFor(value.code, value.stderr, value.stdout)(
          "docker", value.args, { timeout: 100 }
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(DockerPublicArtifactNotPresentError);
      expect((error as Error).message).toBe("Docker command failed");
    }
  });
});

describe("terminal public artifact reader", () => {
  const runReader = async (file: string) => {
    try {
      const result = await execFile(process.execPath, ["--input-type=module", "-e", PUBLIC_ARTIFACT_READER_PROGRAM, file]);
      return { ...result, code: 0 };
    } catch (error) {
      const failure = error as { code?: number; stderr?: string; stdout?: string };
      return { code: failure.code, stderr: failure.stderr, stdout: failure.stdout };
    }
  };

  it("maps only the atomic open's absence to terminal absence", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-artifact-reader-"));
    const file = path.join(directory, "terminal.json");
    try {
      expect((await runReader(file)).code).toBe(42);
      await writeFile(file, "created", "utf8");
      expect((await runReader(file)).stdout).toBe("created");
      await unlink(file);
      // This create/remove sequence represents a path that vanished before
      // its one permitted open; it remains the same typed absence outcome.
      expect((await runReader(file)).code).toBe(42);
      await symlink("/etc/passwd", file);
      expect((await runReader(file)).code).toBe(43);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
