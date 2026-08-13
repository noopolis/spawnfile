import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  ensureDirectory,
  fileExists,
  writeUtf8File
} from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";

import type { DockerRunInvocation } from "./runProjectDocker.js";
import { executeDockerRunWithSupportCleanup } from "./runProjectLifecycle.js";

const invocation = async (detach: boolean): Promise<DockerRunInvocation> => {
  const supportDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-run-lifecycle-"));
  const envFilePath = path.join(supportDirectory, "run.env");
  await writeUtf8File(envFilePath, "TOKEN=secret\n");
  await ensureDirectory(path.join(supportDirectory, "codex"));
  await writeUtf8File(path.join(supportDirectory, "codex", "auth.json"), "{}\n");
  return {
    args: [],
    command: "docker",
    containerName: "test",
    cwd: supportDirectory,
    detach,
    envFilePath,
    imageTag: "test",
    supportDirectory
  };
};

describe("executeDockerRunWithSupportCleanup", () => {
  it("unlinks only the generated env after a detached start", async () => {
    const input = await invocation(true);
    await executeDockerRunWithSupportCleanup(input, async () => ({ containerId: "container" }));
    await expect(fileExists(input.envFilePath)).resolves.toBe(false);
    await expect(fileExists(path.join(input.supportDirectory, "codex", "auth.json")))
      .resolves.toBe(true);
  });

  it("removes all support files when a launch fails", async () => {
    const input = await invocation(true);
    await expect(executeDockerRunWithSupportCleanup(input, async () => {
      throw new SpawnfileError("runtime_error", "start failed");
    })).rejects.toThrow("start failed");
    await expect(fileExists(input.supportDirectory)).resolves.toBe(false);
  });

  it("preserves active auth mounts when detached post-start inspection fails", async () => {
    const input = await invocation(true);
    await expect(executeDockerRunWithSupportCleanup(input, async (prepared) => {
      await prepared.onDetachedStarted?.({ containerId: "container" });
      throw new SpawnfileError("runtime_error", "post-start inspect failed");
    })).rejects.toThrow("post-start inspect failed");
    await expect(fileExists(input.envFilePath)).resolves.toBe(false);
    await expect(fileExists(path.join(input.supportDirectory, "codex", "auth.json")))
      .resolves.toBe(true);
  });

  it("removes all support files after a foreground run", async () => {
    const input = await invocation(false);
    await executeDockerRunWithSupportCleanup(input, async () => undefined);
    await expect(fileExists(input.supportDirectory)).resolves.toBe(false);
  });
});
