import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { readUtf8File, removeDirectory } from "../filesystem/index.js";

import { materializeDockerAuthFixture } from "./fixtures.js";
import { filterDockerAuthE2EScenarios } from "./scenarios.js";

const tempDirectories: string[] = [];

const createTempDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-e2e-fixture-test-"));
  tempDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  for (const directory of tempDirectories.splice(0)) {
    await removeDirectory(directory);
  }
});

describe("materializeDockerAuthFixture", () => {
  it("patches the single-agent fixture with the scenario runtime and auth method", async () => {
    const scenario = filterDockerAuthE2EScenarios({ scenarioIds: ["openclaw-codex"] })[0]!;
    const directory = await createTempDirectory();

    await materializeDockerAuthFixture(scenario, directory);

    const manifest = YAML.parse(await readUtf8File(path.join(directory, "Spawnfile"))) as Record<
      string,
      unknown
    >;
    const execution = manifest.execution as Record<string, unknown>;
    const model = execution.model as Record<string, unknown>;

    expect(manifest.runtime).toBe("openclaw");
    expect(model.primary).toEqual({
      name: "gpt-5",
      provider: "openai"
    });
    expect(model.auth).toEqual({
      method: "codex"
    });
  });

  it("patches all team member manifests", async () => {
    const scenario = filterDockerAuthE2EScenarios({ scenarioIds: ["team-multi-runtime"] })[0]!;
    const directory = await createTempDirectory();

    await materializeDockerAuthFixture(scenario, directory);

    const tinyManifest = YAML.parse(
      await readUtf8File(path.join(directory, "agents", "tinyclaw", "Spawnfile"))
    ) as Record<string, unknown>;
    const execution = tinyManifest.execution as Record<string, unknown>;
    const model = execution.model as Record<string, unknown>;

    expect(tinyManifest.runtime).toBe("tinyclaw");
    expect(model.primary).toEqual({
      name: "gpt-5",
      provider: "openai"
    });
    expect(model.auth).toEqual({
      method: "codex"
    });
  });
});
