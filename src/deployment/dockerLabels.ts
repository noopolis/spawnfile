import { SpawnfileError } from "../shared/index.js";

export const dockerDeploymentLabelKeys = {
  compileFingerprint: "com.spawnfile.compile_fingerprint",
  deployment: "com.spawnfile.deployment",
  project: "com.spawnfile.project",
  unit: "com.spawnfile.unit",
  version: "com.spawnfile.version"
} as const;

export interface DockerDeploymentLabelInput {
  compileFingerprint: string;
  deployment: string;
  project: string;
  unit: string;
  version: string;
}

const dockerLabelValuePattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

const assertIdentifierLabelValue = (key: string, value: string): void => {
  if (!dockerLabelValuePattern.test(value)) {
    throw new SpawnfileError(
      "validation_error",
      `Docker deployment label ${key} must be an identifier`
    );
  }
};

export const createDockerDeploymentLabels = (
  input: DockerDeploymentLabelInput
): Record<string, string> => {
  const labels = {
    [dockerDeploymentLabelKeys.compileFingerprint]: input.compileFingerprint,
    [dockerDeploymentLabelKeys.deployment]: input.deployment,
    [dockerDeploymentLabelKeys.project]: input.project,
    [dockerDeploymentLabelKeys.unit]: input.unit,
    [dockerDeploymentLabelKeys.version]: input.version
  };

  for (const [key, value] of Object.entries(labels)) {
    assertIdentifierLabelValue(key, value);
  }

  return labels;
};

export const appendDockerLabelArgs = (
  args: string[],
  labels: Record<string, string>
): void => {
  for (const [key, value] of Object.entries(labels).sort(([left], [right]) => left.localeCompare(right))) {
    args.push("--label", `${key}=${value}`);
  }
};
