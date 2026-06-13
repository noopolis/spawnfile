import { SpawnfileError } from "../shared/index.js";

import { createConsumerDockerRunner } from "./dockerRunner.js";
import type { DockerCommandRunner } from "./dockerRunner.js";
import { parseDistributionReport } from "./distributionReportSchema.js";
import { extractSingleFileFromTar } from "./tarReader.js";
import {
  DISTRIBUTION_REPORT_IMAGE_PATH,
  IMAGE_CONTRACT_VERSION
} from "./types.js";
import type { DistributionReport } from "./types.js";

const REPORT_SIZE_CAP_BYTES = 4 * 1024 * 1024;
const LABEL_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

export type { DockerCommandRunner } from "./dockerRunner.js";

export interface ImageInspection {
  compileFingerprint: string;
  labels: Record<string, string>;
  report: DistributionReport;
}

export interface ExtractImageOptions {
  dockerCommand?: string;
  dockerContext?: string;
  dockerHost?: string;
  pull?: boolean;
  runDocker?: DockerCommandRunner;
}

export const resolveDockerBaseArgs = (options: {
  dockerContext?: string;
  dockerHost?: string;
}): string[] => {
  if (options.dockerContext) {
    return ["--context", options.dockerContext];
  }
  if (options.dockerHost) {
    return ["--host", options.dockerHost];
  }
  return [];
};

const assertContractLabels = (labels: Record<string, string>): void => {
  const contract = labels["com.spawnfile.image_contract"];
  if (!contract) {
    throw new SpawnfileError(
      "validation_error",
      "Image is not a Spawnfile image: missing com.spawnfile.image_contract label"
    );
  }
  if (contract !== IMAGE_CONTRACT_VERSION) {
    throw new SpawnfileError(
      "validation_error",
      `Unsupported image contract ${contract}; this CLI supports ${IMAGE_CONTRACT_VERSION}`
    );
  }
  for (const key of ["com.spawnfile.project", "com.spawnfile.compile_fingerprint"]) {
    const value = labels[key];
    if (!value || !LABEL_VALUE_PATTERN.test(value)) {
      throw new SpawnfileError(
        "validation_error",
        `Image label ${key} is missing or not identifier-only`
      );
    }
  }
};

/**
 * Pulls (optionally), inspects labels, and extracts the embedded distribution
 * report from an image without starting its entrypoint. Uses a stopped helper
 * container and guarantees cleanup.
 */
export const extractImageReport = async (
  imageRef: string,
  options: ExtractImageOptions = {}
): Promise<ImageInspection> => {
  const dockerCommand = options.dockerCommand ?? "docker";
  const baseArgs = resolveDockerBaseArgs(options);
  const runDocker = options.runDocker ?? createConsumerDockerRunner(dockerCommand, baseArgs);

  if (options.pull) {
    await runDocker(["pull", imageRef]);
  }

  const labelsRaw = (await runDocker([
    "image",
    "inspect",
    "--format",
    "{{json .Config.Labels}}",
    imageRef
  ])).toString("utf8").trim();
  let labels: Record<string, string>;
  try {
    labels = (JSON.parse(labelsRaw) as Record<string, string> | null) ?? {};
  } catch {
    throw new SpawnfileError("validation_error", `Unable to read labels for image ${imageRef}`);
  }
  assertContractLabels(labels);

  const reportPath = labels["com.spawnfile.report"] ?? DISTRIBUTION_REPORT_IMAGE_PATH;
  const helperName = `spawnfile-inspect-${Date.now().toString(36)}-${Math.floor(
    Number(process.pid)
  ).toString(36)}`;

  await runDocker(["create", "--name", helperName, imageRef]);
  let tar: Buffer;
  try {
    tar = await runDocker(["cp", `${helperName}:${reportPath}`, "-"]);
  } finally {
    await runDocker(["rm", "-f", helperName]).catch(() => undefined);
  }

  const reportBytes = extractSingleFileFromTar(tar, { maxBytes: REPORT_SIZE_CAP_BYTES });
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(reportBytes.toString("utf8"));
  } catch {
    throw new SpawnfileError(
      "validation_error",
      `Embedded report in ${imageRef} is not valid JSON`
    );
  }
  const report = parseDistributionReport(parsedJson, `embedded report in ${imageRef}`);

  if (report.compile_fingerprint !== labels["com.spawnfile.compile_fingerprint"]) {
    throw new SpawnfileError(
      "validation_error",
      `Embedded report fingerprint does not match the image label for ${imageRef}`
    );
  }

  return {
    compileFingerprint: report.compile_fingerprint,
    labels,
    report
  };
};
