import path from "node:path";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import {
  DISTRIBUTION_REPORT_OUTPUT_FILE,
  verifyDistributionReport
} from "../distribution/index.js";
import { SpawnfileError } from "../shared/index.js";

import {
  buildProject,
  type BuildProjectOptions,
  type BuildProjectResult
} from "./buildProject.js";

export type DockerPushRunner = (
  command: string,
  args: string[]
) => Promise<string>;

export interface PublishProjectOptions extends BuildProjectOptions {
  pushRunner?: DockerPushRunner;
}

export interface PublishProjectResult extends BuildProjectResult {
  digest: string | null;
}

/* v8 ignore start -- docker push runner is covered by distribution E2E */
const runDockerCapture: DockerPushRunner = async (command, args) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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
        new SpawnfileError("runtime_error", `docker ${args[0]} failed (${code}): ${stderr.join("").trim()}`)
      );
    });
  });
/* v8 ignore stop */

const resolvePushedDigest = async (
  command: string,
  imageTag: string,
  runDocker: DockerPushRunner
): Promise<string | null> => {
  try {
    const raw = (
      await runDocker(command, ["image", "inspect", "--format", "{{json .RepoDigests}}", imageTag])
    ).trim();
    const digests = JSON.parse(raw) as string[];
    const match = digests
      .map((entry) => (entry.includes("@") ? entry.slice(entry.indexOf("@") + 1) : null))
      .find((entry): entry is string => Boolean(entry));
    return match ?? null;
  } catch {
    return null;
  }
};

/**
 * Compiles, builds, verifies, and pushes a project image. Pre-push verification
 * refuses to publish a report that leaks creator paths or omits secret markers.
 */
export const publishProject = async (
  inputPath: string,
  options: PublishProjectOptions = {}
): Promise<PublishProjectResult> => {
  if (!options.imageTag) {
    throw new SpawnfileError("validation_error", "publish requires --tag with a registry image reference");
  }

  const buildResult = await buildProject(inputPath, options);
  const dockerCommand = options.dockerCommand ?? "docker";
  const runDocker = options.pushRunner ?? runDockerCapture;

  const reportPath = path.join(buildResult.outputDirectory, DISTRIBUTION_REPORT_OUTPUT_FILE);
  let parsedReport: unknown;
  try {
    parsedReport = JSON.parse(await readFile(reportPath, "utf8"));
  } catch (error) {
    /* v8 ignore next 2 -- compile always emits the report; defensive only */
    const reason = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError("validation_error", `Unable to read distribution report for publish: ${reason}`);
  }
  verifyDistributionReport({
    forbiddenPathFragments: [
      path.resolve(inputPath),
      buildResult.outputDirectory,
      buildResult.report.root
    ],
    report: parsedReport
  });

  await runDocker(dockerCommand, ["push", buildResult.imageTag]);
  const digest = await resolvePushedDigest(dockerCommand, buildResult.imageTag, runDocker);

  return {
    ...buildResult,
    digest
  };
};
