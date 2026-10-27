import { randomUUID } from "node:crypto";

import { SpawnfileError } from "../shared/errors.js";
import {
  DAIMON_DOCKER_RUNTIME_SECURITY_ARGS,
  daimonEngineDockerSecurityArgsForConfigs,
  materializeDaimonGrokSeccompProfile
} from "../shared/daimonCodexDocker.js";

import { readDaimonImageContract } from "./consumeImageDaimonContract.js";
import type { DaimonEngineDescriptors } from "../runtime/daimon/engineDescriptorSchema.js";
import type { DockerCommandRunner } from "./dockerRunner.js";
import { extractSingleFileFromTar } from "./tarReader.js";
import type { DistributionReport, DistributionRuntimeInstance } from "./types.js";

const DAIMON_CONFIG_SIZE_CAP_BYTES = 4 * 1024 * 1024;

const daimonInstancesFrom = (report: DistributionReport): DistributionRuntimeInstance[] =>
  report.runtime_instances.filter((instance) => instance.runtime === "daimon");

const assertAbsoluteConfigPath = (instance: DistributionRuntimeInstance): string => {
  if (!instance.config_path.startsWith("/")) {
    throw new SpawnfileError(
      "validation_error",
      "Daimon runtime instance has a non-absolute generated config path"
    );
  }
  return instance.config_path;
};

const readDaimonConfigSourcesFromImage = async (
  imageRef: string,
  instances: DistributionRuntimeInstance[],
  runDocker: DockerCommandRunner,
  securityDirectory: string
): Promise<{ sources: string[]; engineDescriptors: DaimonEngineDescriptors }> => {
  const helperName = `spawnfile-daimon-config-${randomUUID()}`;
  await runDocker(["create", "--name", helperName, imageRef]);
  try {
    const sources: string[] = [];
    for (const instance of instances) {
      let tar: Buffer;
      try {
        tar = await runDocker(["cp", `${helperName}:${assertAbsoluteConfigPath(instance)}`, "-"]);
      } catch (error) {
        if (error instanceof SpawnfileError) throw error;
        throw new SpawnfileError(
          "validation_error",
          "Could not read Daimon's generated organization config before Docker launch"
        );
      }
      sources.push(extractSingleFileFromTar(tar, { maxBytes: DAIMON_CONFIG_SIZE_CAP_BYTES }).toString("utf8"));
    }
    return { sources, engineDescriptors: await readDaimonImageContract(helperName, runDocker, securityDirectory) };
  } finally {
    await runDocker(["rm", "-f", helperName]).catch(() => undefined);
  }
};

export const resolveDaimonRuntimeForImage = async (
  imageRef: string,
  report: DistributionReport,
  runDocker: DockerCommandRunner,
  securityDirectory: string
): Promise<{ securityArgs: string[]; engineDescriptors?: DaimonEngineDescriptors }> => {
  const daimonInstances = daimonInstancesFrom(report);
  if (daimonInstances.length === 0) return { securityArgs: [] };
  const { sources, engineDescriptors } = await readDaimonConfigSourcesFromImage(imageRef, daimonInstances, runDocker, securityDirectory);
  return { engineDescriptors, securityArgs: [
    ...DAIMON_DOCKER_RUNTIME_SECURITY_ARGS,
    ...(await daimonEngineDockerSecurityArgsForConfigs(sources, () => materializeDaimonGrokSeccompProfile(securityDirectory)))
  ] };
};
