import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { runCli } from "../cli/runCli.js";
import {
  DISTRIBUTION_REPORT_IMAGE_PATH,
  IMAGE_CONTRACT_VERSION
} from "../distribution/index.js";
import { removeDirectory } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";

const DEFAULT_FIXTURE_DIRECTORY = fileURLToPath(
  new URL("../../fixtures/distribution-org", import.meta.url)
);
const LABEL_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

export interface DistributionImageLogger {
  info(message: string): void;
}

export interface RunDistributionImageE2EOptions {
  dockerCommand?: string;
  fixtureDirectory?: string;
  imageTag?: string;
  keepArtifacts?: boolean;
  keepImages?: boolean;
  logger?: DistributionImageLogger;
}

export interface RunDistributionImageE2EResult {
  compileFingerprint: string;
  imageTag: string;
  outputDirectory: string;
}

const runDockerCommand = async (
  dockerCommand: string,
  args: string[]
): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(dockerCommand, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on("data", (chunk: Buffer | string) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk: Buffer | string) => stderr.push(String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.join(""));
        return;
      }
      reject(
        new SpawnfileError(
          "runtime_error",
          `docker ${args[0]} failed (${code}): ${stderr.join("").trim()}`
        )
      );
    });
  });

const assertPathFree = (serialized: string, forbidden: string[]): void => {
  for (const candidate of forbidden) {
    if (candidate && serialized.includes(candidate)) {
      throw new SpawnfileError(
        "validation_error",
        `Distribution report leaks creator path fragment: ${candidate}`
      );
    }
  }
};

export const runDistributionImageE2E = async (
  options: RunDistributionImageE2EOptions = {}
): Promise<RunDistributionImageE2EResult> => {
  const logger = options.logger ?? { info: (message: string) => console.log(message) };
  const dockerCommand = options.dockerCommand ?? "docker";
  const fixtureDirectory = options.fixtureDirectory ?? DEFAULT_FIXTURE_DIRECTORY;
  const runId = Date.now().toString(36);
  const imageTag = options.imageTag ?? `spawnfile-e2e-distribution:${runId}`;
  const helperName = `spawnfile-inspect-e2e-${runId}`;

  const workRoot = await mkdtemp(path.join(os.tmpdir(), "spawnfile-dist-e2e-"));
  const projectDirectory = path.join(workRoot, "project");
  await cp(fixtureDirectory, projectDirectory, { recursive: true });
  const outputDirectory = path.join(projectDirectory, ".spawn");

  try {
    logger.info(`compiling fixture ${projectDirectory}`);
    const compileExit = await runCli([
      "compile",
      projectDirectory,
      "--out",
      outputDirectory
    ]);
    if (compileExit !== 0) {
      throw new SpawnfileError("compile_error", `compile exited ${compileExit}`);
    }

    logger.info(`building image ${imageTag} (manual docker build from output root)`);
    await runDockerCommand(dockerCommand, ["build", "-t", imageTag, outputDirectory]);

    logger.info("inspecting image labels");
    const labelsJson = await runDockerCommand(dockerCommand, [
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      imageTag
    ]);
    const labels = JSON.parse(labelsJson) as Record<string, string>;
    const required = [
      "com.spawnfile.image_contract",
      "com.spawnfile.project",
      "com.spawnfile.compile_fingerprint",
      "com.spawnfile.report"
    ];
    for (const key of required) {
      if (!labels[key]) {
        throw new SpawnfileError("validation_error", `image label missing: ${key}`);
      }
      if (key !== "com.spawnfile.report" && !LABEL_VALUE_PATTERN.test(labels[key]!)) {
        throw new SpawnfileError(
          "validation_error",
          `image label ${key} is not identifier-only: ${labels[key]}`
        );
      }
    }
    if (labels["com.spawnfile.image_contract"] !== IMAGE_CONTRACT_VERSION) {
      throw new SpawnfileError(
        "validation_error",
        `unexpected image contract: ${labels["com.spawnfile.image_contract"]}`
      );
    }
    if (labels["com.spawnfile.report"] !== DISTRIBUTION_REPORT_IMAGE_PATH) {
      throw new SpawnfileError(
        "validation_error",
        `unexpected report path label: ${labels["com.spawnfile.report"]}`
      );
    }

    logger.info("extracting embedded report without starting the entrypoint");
    const extractedPath = path.join(workRoot, "extracted-report.json");
    await runDockerCommand(dockerCommand, ["create", "--name", helperName, imageTag]);
    try {
      await runDockerCommand(dockerCommand, [
        "cp",
        `${helperName}:${labels["com.spawnfile.report"]}`,
        extractedPath
      ]);
    } finally {
      await runDockerCommand(dockerCommand, ["rm", "-f", helperName]).catch(() => undefined);
    }

    const serialized = await readFile(extractedPath, "utf8");
    const report = JSON.parse(serialized) as {
      compile_fingerprint: string;
      organization: { project: string };
      secrets: Record<string, Array<{ generated: boolean; name: string; required: boolean }>>;
      version: string;
    };

    if (report.version !== "spawnfile.distribution-report.v1") {
      throw new SpawnfileError("validation_error", `unexpected report version: ${report.version}`);
    }
    if (report.compile_fingerprint !== labels["com.spawnfile.compile_fingerprint"]) {
      throw new SpawnfileError(
        "validation_error",
        "embedded report fingerprint does not match the image label"
      );
    }
    assertPathFree(serialized, [workRoot, projectDirectory, outputDirectory, os.homedir(), ".spawn"]);
    for (const category of ["model", "project", "runtime", "surface"]) {
      if (!Array.isArray(report.secrets[category])) {
        throw new SpawnfileError("validation_error", `secrets.${category} missing from report`);
      }
    }

    logger.info(`distribution image contract verified for ${report.organization.project}`);
    return {
      compileFingerprint: report.compile_fingerprint,
      imageTag,
      outputDirectory
    };
  } finally {
    if (!options.keepImages) {
      await runDockerCommand(dockerCommand, ["rmi", "-f", imageTag]).catch(() => undefined);
    }
    if (!options.keepArtifacts) {
      await removeDirectory(workRoot).catch(() => undefined);
    }
  }
};
