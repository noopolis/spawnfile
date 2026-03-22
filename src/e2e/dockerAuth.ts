import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { requireAuthProfile } from "../auth/index.js";
import {
  buildProject,
  createDockerRunInvocation,
  runDockerContainer,
  syncProjectAuth
} from "../compiler/index.js";
import { removeDirectory } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";

import { materializeDockerAuthFixture } from "./fixtures.js";
import { waitForRuntimeReady, promptRuntime } from "./runtimePrompts.js";
import { filterDockerAuthE2EScenarios } from "./scenarios.js";
import type {
  DockerAuthE2EFilters,
  DockerAuthE2EScenario,
  DockerAuthE2EScenarioResult
} from "./types.js";
import type { ContainerRuntimeInstanceReport } from "../report/index.js";

export interface DockerAuthE2ELogger {
  error(message: string): void;
  info(message: string): void;
}

export interface RunDockerAuthE2EOptions extends DockerAuthE2EFilters {
  claudeCodeDirectory?: string;
  codexDirectory?: string;
  dockerCommand?: string;
  envFilePath?: string;
  keepArtifacts?: boolean;
  keepImages?: boolean;
  logger?: DockerAuthE2ELogger;
}

export interface RunDockerAuthE2EResult {
  results: DockerAuthE2EScenarioResult[];
}

const DEFAULT_ENV_FILE = path.resolve(process.cwd(), "../headhunter/.env");

const createLogger = (logger?: DockerAuthE2ELogger): DockerAuthE2ELogger =>
  logger ?? {
    error: (message) => console.error(message),
    info: (message) => console.log(message)
  };

const createScenarioImageTag = (scenario: DockerAuthE2EScenario): string =>
  `spawnfile-e2e-${scenario.id}-${Date.now()}`;

const createScenarioPrompt = (scenarioId: string, runtime: string): string =>
  `Reply with exactly SF-E2E-${scenarioId.toUpperCase()}-${runtime.toUpperCase()} and nothing else.`;

const extractSentinel = (prompt: string): string =>
  prompt.replace("Reply with exactly ", "").replace(" and nothing else.", "");

const findPromptInstance = (
  scenario: DockerAuthE2EScenario,
  instances: ContainerRuntimeInstanceReport[],
  runtime: string
): ContainerRuntimeInstanceReport | null => {
  const runtimeInstances = instances.filter((instance) => instance.runtime === runtime);
  if (runtimeInstances.length === 0) {
    return null;
  }

  if (scenario.kind === "single-agent") {
    return runtimeInstances[0] ?? null;
  }

  return runtimeInstances[0] ?? null;
};

const resolveEnvFilePath = (inputPath?: string): string | undefined =>
  inputPath ?? DEFAULT_ENV_FILE;

const withSpawnfileHome = async <T>(
  spawnfileHome: string,
  fn: () => Promise<T>
): Promise<T> => {
  const previousValue = process.env.SPAWNFILE_HOME;
  process.env.SPAWNFILE_HOME = spawnfileHome;

  try {
    return await fn();
  } finally {
    if (typeof previousValue === "string") {
      process.env.SPAWNFILE_HOME = previousValue;
    } else {
      delete process.env.SPAWNFILE_HOME;
    }
  }
};

const runDockerCommand = async (
  dockerCommand: string,
  args: string[]
): Promise<string> => {
  const { spawn } = await import("node:child_process");

  return new Promise<string>((resolve, reject) => {
    const child = spawn(dockerCommand, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    child.stdout.on("data", (chunk: Buffer | string) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk: Buffer | string) => stderr.push(String(chunk)));
    child.once("error", (error) => {
      reject(
        new SpawnfileError(
          "runtime_error",
          `Unable to start docker command ${dockerCommand}: ${error.message}`
        )
      );
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(stdout.join("").trim());
        return;
      }

      reject(
        new SpawnfileError(
          "runtime_error",
          signal
            ? `Docker command exited from signal ${signal}: ${dockerCommand} ${args.join(" ")}`
            : `Docker command failed with exit code ${code ?? "unknown"}: ${dockerCommand} ${args.join(" ")}\n${stderr.join("")}`.trim()
        )
      );
    });
  });
};

const cleanupDockerArtifacts = async (
  dockerCommand: string,
  containerName: string,
  imageTag: string,
  options: { keepImages: boolean }
): Promise<void> => {
  try {
    await runDockerCommand(dockerCommand, ["rm", "-f", containerName]);
  } catch {
    // Ignore best-effort cleanup failures.
  }

  if (options.keepImages) {
    return;
  }

  try {
    await runDockerCommand(dockerCommand, ["image", "rm", "-f", imageTag]);
  } catch {
    // Ignore best-effort cleanup failures.
  }
};

const readDockerLogs = async (
  dockerCommand: string,
  containerName: string
): Promise<string> => {
  try {
    return await runDockerCommand(dockerCommand, ["logs", containerName]);
  } catch {
    return "";
  }
};

const runScenario = async (
  scenario: DockerAuthE2EScenario,
  options: Required<Pick<RunDockerAuthE2EOptions, "dockerCommand" | "keepArtifacts" | "keepImages">> &
    Pick<
      RunDockerAuthE2EOptions,
      "claudeCodeDirectory" | "codexDirectory" | "envFilePath" | "logger"
    >
): Promise<DockerAuthE2EScenarioResult> => {
  const startedAt = Date.now();
  const logger = createLogger(options.logger);
  const scenarioRoot = await mkdtemp(path.join(os.tmpdir(), `spawnfile-e2e-${scenario.id}-`));
  const projectDirectory = path.join(scenarioRoot, "project");
  const outputDirectory = path.join(scenarioRoot, "dist");
  const spawnfileHome = path.join(scenarioRoot, "spawnfile-home");
  const profileName = "e2e";
  const imageTag = createScenarioImageTag(scenario);
  const containerName = `spawnfile-e2e-${scenario.id}`;

  logger.info(`scenario ${scenario.id}: materializing fixture`);

  try {
    await materializeDockerAuthFixture(scenario, projectDirectory);

    await withSpawnfileHome(spawnfileHome, async () => {
      logger.info(`scenario ${scenario.id}: syncing auth`);
      await syncProjectAuth(projectDirectory, {
        claudeCodeDirectory: options.claudeCodeDirectory,
        codexDirectory: options.codexDirectory,
        envFilePath: resolveEnvFilePath(options.envFilePath),
        profileName
      });

      logger.info(`scenario ${scenario.id}: building image ${imageTag}`);
      const buildResult = await buildProject(projectDirectory, {
        dockerCommand: options.dockerCommand,
        imageTag,
        outputDirectory
      });
      const runtimeInstances = buildResult.report.container?.runtime_instances ?? [];
      const authProfile = await requireAuthProfile(profileName);
      const invocation = await createDockerRunInvocation(buildResult, imageTag, {
        authProfile,
        containerName,
        detach: true,
        dockerCommand: options.dockerCommand
      });

      try {
        logger.info(`scenario ${scenario.id}: starting container ${containerName}`);
        await runDockerContainer(invocation);

        for (const check of scenario.promptChecks) {
          const prompt = createScenarioPrompt(scenario.id, check.runtime);
          const sentinel = extractSentinel(prompt);
          const promptInstance = findPromptInstance(scenario, runtimeInstances, check.runtime);

          logger.info(`scenario ${scenario.id}: waiting for ${check.runtime}`);
          await waitForRuntimeReady(check.runtime);

          logger.info(`scenario ${scenario.id}: prompting ${check.runtime}`);
          const output = await promptRuntime(check.runtime, {
            agentName: check.agentName,
            command: options.dockerCommand,
            configPath: promptInstance?.config_path,
            containerName,
            homePath: promptInstance?.home_path ?? undefined,
            prompt
          });

          if (!output.includes(sentinel)) {
            throw new SpawnfileError(
              "runtime_error",
              `Scenario ${scenario.id} did not return sentinel ${sentinel} for ${check.runtime}`
            );
          }
        }
      } catch (error) {
        const logs = await readDockerLogs(options.dockerCommand, containerName);
        throw new SpawnfileError(
          "runtime_error",
          `${error instanceof Error ? error.message : String(error)}${logs ? `\n\nDocker logs:\n${logs}` : ""}`
        );
      } finally {
        await cleanupDockerArtifacts(options.dockerCommand, containerName, imageTag, {
          keepImages: options.keepImages
        });
        await removeDirectory(invocation.supportDirectory);
      }
    });

    if (!options.keepArtifacts) {
      await removeDirectory(scenarioRoot);
    }

    return {
      durationMs: Date.now() - startedAt,
      id: scenario.id,
      success: true
    };
  } catch (error) {
    if (!options.keepArtifacts) {
      await removeDirectory(scenarioRoot);
    }

    return {
      durationMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
      id: scenario.id,
      success: false
    };
  }
};

const formatFailures = (results: DockerAuthE2EScenarioResult[]): string =>
  results
    .filter((result) => !result.success)
    .map((result) => `- ${result.id}: ${result.errorMessage ?? "unknown error"}`)
    .join("\n");

export const runDockerAuthE2E = async (
  options: RunDockerAuthE2EOptions = {}
): Promise<RunDockerAuthE2EResult> => {
  const logger = createLogger(options.logger);
  const scenarios = filterDockerAuthE2EScenarios(options);

  if (scenarios.length === 0) {
    throw new SpawnfileError("validation_error", "No Docker auth E2E scenarios matched the filter");
  }

  const results: DockerAuthE2EScenarioResult[] = [];

  for (const scenario of scenarios) {
    const result = await runScenario(scenario, {
      claudeCodeDirectory: options.claudeCodeDirectory,
      codexDirectory: options.codexDirectory,
      dockerCommand: options.dockerCommand ?? "docker",
      envFilePath: options.envFilePath,
      keepArtifacts: options.keepArtifacts ?? false,
      keepImages: options.keepImages ?? false,
      logger
    });
    results.push(result);
    logger.info(
      `${result.success ? "PASS" : "FAIL"} ${result.id} (${Math.round(result.durationMs / 1000)}s)`
    );
  }

  if (results.some((result) => !result.success)) {
    throw new SpawnfileError(
      "runtime_error",
      `Docker auth E2E failed:\n${formatFailures(results)}`
    );
  }

  return { results };
};
