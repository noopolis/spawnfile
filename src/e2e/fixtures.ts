import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import { copyDirectory, readUtf8File, writeUtf8File } from "../filesystem/index.js";

import type { DockerAuthE2EScenario, E2EAgentSpec } from "./types.js";

type MutableJson = Record<string, unknown>;

const FIXTURES_ROOT = fileURLToPath(new URL("../../fixtures/e2e", import.meta.url));

const readYamlFile = async (filePath: string): Promise<MutableJson> =>
  YAML.parse(await readUtf8File(filePath)) as MutableJson;

const writeYamlFile = async (filePath: string, value: MutableJson): Promise<void> => {
  await writeUtf8File(filePath, YAML.stringify(value));
};

const applyAgentSpec = (manifest: MutableJson, spec: E2EAgentSpec): MutableJson => ({
  ...manifest,
  execution: {
    ...((manifest.execution as MutableJson | undefined) ?? {}),
    model: {
      ...((((manifest.execution as MutableJson | undefined)?.model as MutableJson | undefined) ?? {})),
      auth: {
        method: spec.authMethod
      },
      primary: {
        name: spec.modelName,
        provider: spec.provider
      }
    }
  },
  kind: "agent",
  name: spec.name,
  runtime: spec.runtime
});

const patchSingleAgentFixture = async (
  destinationDirectory: string,
  scenario: DockerAuthE2EScenario
): Promise<void> => {
  const manifestPath = path.join(destinationDirectory, "Spawnfile");
  const manifest = await readYamlFile(manifestPath);
  await writeYamlFile(manifestPath, applyAgentSpec(manifest, scenario.agents[0]!));
};

const patchTeamFixture = async (
  destinationDirectory: string,
  scenario: DockerAuthE2EScenario
): Promise<void> => {
  for (const agent of scenario.agents) {
    const manifestPath = path.join(destinationDirectory, "agents", agent.directoryName, "Spawnfile");
    const manifest = await readYamlFile(manifestPath);
    await writeYamlFile(manifestPath, applyAgentSpec(manifest, agent));
  }
};

export const materializeDockerAuthFixture = async (
  scenario: DockerAuthE2EScenario,
  destinationDirectory: string
): Promise<void> => {
  const sourceDirectory = path.join(FIXTURES_ROOT, scenario.fixture);
  await copyDirectory(sourceDirectory, destinationDirectory);

  if (scenario.fixture === "agent") {
    await patchSingleAgentFixture(destinationDirectory, scenario);
    return;
  }

  await patchTeamFixture(destinationDirectory, scenario);
};
