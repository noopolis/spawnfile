import { listDeploymentRecords, listHomeDeploymentRecords } from "../deployment/index.js";

import { resolveCommandInput } from "./resolveCommandInput.js";
import type { UsageCommandOptions } from "./usageCommand.js";
import type { UsageCommandLiveHandlers } from "./usageCommandLive.js";

type UsageDeploymentRecordLoader = NonNullable<UsageCommandLiveHandlers["listDeploymentRecords"]>;

export interface UsageDeploymentSource {
  loader: UsageDeploymentRecordLoader;
  outputDirectory: string;
}

export const resolveUsageDeploymentSource = async (
  inputPath: string,
  options: UsageCommandOptions,
  handlers: UsageCommandLiveHandlers,
  outputDirectory: string
): Promise<UsageDeploymentSource> => {
  const listProject = handlers.listDeploymentRecords ?? listDeploymentRecords;
  const listHome = handlers.listHomeDeploymentRecords ?? listHomeDeploymentRecords;
  const commandInput = resolveCommandInput(inputPath);
  const usedDefaultPath = inputPath === process.cwd();

  if (options.out !== undefined || (!usedDefaultPath && commandInput.kind === "project")) {
    return { loader: listProject, outputDirectory };
  }

  if (commandInput.kind === "image" || (options.deployment !== undefined && usedDefaultPath)) {
    return { loader: listHome, outputDirectory };
  }

  if (usedDefaultPath) {
    const projectRecords = await listProject(outputDirectory);
    if (projectRecords.length > 0) {
      return { loader: async () => projectRecords, outputDirectory };
    }
    return { loader: listHome, outputDirectory };
  }

  return { loader: listProject, outputDirectory };
};
