import path from "node:path";

import { SpawnfileError } from "../shared/index.js";

const deploymentNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const normalizeDeploymentName = (name: string | undefined): string => {
  const normalized = (name ?? "default").trim();
  if (!deploymentNamePattern.test(normalized)) {
    throw new SpawnfileError(
      "validation_error",
      `Deployment name must be kebab-case: ${name ?? ""}`
    );
  }

  return normalized;
};

export const resolveDeploymentRecordsDirectory = (outputDirectory: string): string =>
  path.join(outputDirectory, "deployments");

export const resolveDeploymentRecordPath = (
  outputDirectory: string,
  deploymentName: string
): string =>
  path.join(resolveDeploymentRecordsDirectory(outputDirectory), `${normalizeDeploymentName(deploymentName)}.json`);
