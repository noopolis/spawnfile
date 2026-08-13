import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { ensureDirectory, removeDirectory, writeUtf8File } from "../filesystem/index.js";
import { checkClaudeAuth, checkDockerRemoteContext } from "./preflightCheckers.js";
import type { PreflightCommandRunner } from "./preflightTypes.js";

const temporaryDirectories: string[] = [];

const createTempDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-preflight-checkers-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await removeDirectory(directory);
  }
});

describe("checkClaudeAuth", () => {
  it("does not pass on settings.json without Claude Code credentials", async () => {
    const home = await createTempDirectory();
    await ensureDirectory(path.join(home, ".claude"));
    await writeUtf8File(path.join(home, ".claude", "settings.json"), "{}\n");

    const result = await checkClaudeAuth(path.join(home, ".claude", ".credentials.json"));

    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain(".credentials.json");
  });
});

describe("checkDockerRemoteContext", () => {
  it("requires the named remote context to be reachable", async () => {
    const commandRunner: PreflightCommandRunner = async () => ({
      exitCode: 1,
      stderr: "remote daemon unreachable",
      stdout: "",
      timedOut: false
    });

    const result = await checkDockerRemoteContext(
      commandRunner,
      "docker",
      "4090",
      ["default", "4090"],
      "docker-context-4090",
      3000
    );

    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("remote daemon unreachable");
  });
});
