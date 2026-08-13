import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readUtf8File, removeDirectory, writeUtf8File } from "../filesystem/index.js";
import { rewriteMemoryPaths, toRootfsPath } from "./runtimeRootfsPaths.js";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const directory = cleanupDirs.pop();
    if (directory) {
      await removeDirectory(directory);
    }
  }
});

describe("runtimeRootfsPaths", () => {
  it("joins a container-absolute path onto a local rootfs root", () => {
    expect(toRootfsPath("/tmp/rootfs", "/var/lib/spawnfile/memory/arun")).toBe(
      "/tmp/rootfs/var/lib/spawnfile/memory/arun"
    );
    expect(toRootfsPath("/tmp/rootfs", "var/lib/spawnfile/memory/arun")).toBe(
      "/tmp/rootfs/var/lib/spawnfile/memory/arun"
    );
  });

  it("rewrites every agent's memory.runtime_home_path onto the local rootfs and returns the first events.jsonl path", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-rootfs-paths-test-"));
    cleanupDirs.push(directory);
    const configPath = path.join(directory, "config.json");
    await writeUtf8File(
      configPath,
      JSON.stringify({
        agents: [
          { memory: { runtime_home_path: "/var/lib/spawnfile/memory/arun" } },
          { memory: undefined },
          { memory: { runtime_home_path: "/var/lib/spawnfile/memory/eleanor" } }
        ]
      })
    );

    const eventsPath = await rewriteMemoryPaths(configPath, path.join(directory, "rootfs"));
    expect(eventsPath).toBe(path.join(directory, "rootfs", "var/lib/spawnfile/memory/arun", "memory", "events.jsonl"));

    const rewritten = JSON.parse(await readUtf8File(configPath)) as {
      agents: Array<{ memory?: { runtime_home_path?: string } }>;
    };
    expect(rewritten.agents[0]?.memory?.runtime_home_path).toBe(
      path.join(directory, "rootfs", "var/lib/spawnfile/memory/arun")
    );
    expect(rewritten.agents[2]?.memory?.runtime_home_path).toBe(
      path.join(directory, "rootfs", "var/lib/spawnfile/memory/eleanor")
    );
  });
});
