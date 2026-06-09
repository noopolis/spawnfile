import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  upProject,
  type UpProjectResult
} from "../compiler/index.js";
import { runCli } from "../cli/runCli.js";
import { removeDirectory } from "../filesystem/index.js";
import { isSpawnfileError, SpawnfileError } from "../shared/index.js";
import {
  assertPicoClawWorkspace,
  PICOCLAW_PORT,
  PICOCLAW_WORKSPACE,
  startPicoClawMockModelServer,
  waitForPicoClawSchedule
} from "./operationalSmokePicoclaw.js";

const DEFAULT_FIXTURE_DIRECTORY = fileURLToPath(
  new URL("../../fixtures/e2e/operational-smoke", import.meta.url)
);
const MOLTNET_PORT = 19087;

export interface OperationalSmokeLogger {
  info(message: string): void;
}

export interface RunOperationalSmokeE2EOptions {
  containerName?: string;
  dockerCommand?: string;
  fixtureDirectory?: string;
  imageTag?: string;
  keepArtifacts?: boolean;
  keepImages?: boolean;
  logger?: OperationalSmokeLogger;
  outputDirectory?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface RunOperationalSmokeE2EResult {
  containerName: string;
  imageTag: string;
  outputDirectory: string;
}

type DockerCommandRunner = (dockerCommand: string, args: string[]) => Promise<string>;

export interface OperationalSmokeDependencies {
  removeDirectory?: typeof removeDirectory;
  runCli?: typeof runCli;
  runDockerCommand?: DockerCommandRunner;
  sleep?: (delayMs: number) => Promise<void>;
  upProject?: typeof upProject;
}

interface PollOptions {
  intervalMs: number;
  sleep: (delayMs: number) => Promise<void>;
  timeoutMs: number;
}

const sleep = async (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

const loggerFor = (logger?: OperationalSmokeLogger): OperationalSmokeLogger =>
  logger ?? { info: (message) => console.log(message) };

const runDockerCommand: DockerCommandRunner = async (dockerCommand, args) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(dockerCommand, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on("data", (chunk: Buffer | string) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk: Buffer | string) => stderr.push(String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve(stdout.join("").trim())
        : reject(new Error(stderr.join("").trim() || `${dockerCommand} ${args.join(" ")} failed`))
    );
  });

const poll = async <T>(
  description: string,
  options: PollOptions,
  attempt: () => Promise<T | null>
): Promise<T> => {
  const attempts = Math.max(1, Math.ceil(options.timeoutMs / options.intervalMs));
  let lastError: unknown;
  for (let index = 0; index <= attempts; index += 1) {
    try {
      const result = await attempt();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await options.sleep(options.intervalMs);
  }

  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new SpawnfileError("runtime_error", `${description} did not become ready${suffix}`);
};

const dockerExec = (
  runCommand: DockerCommandRunner,
  dockerCommand: string,
  containerName: string,
  args: string[]
): Promise<string> => runCommand(dockerCommand, ["exec", containerName, ...args]);

const dockerCurl = (
  runCommand: DockerCommandRunner,
  dockerCommand: string,
  containerName: string,
  url: string
): Promise<string> => dockerExec(runCommand, dockerCommand, containerName, ["curl", "-sf", url]);

const parseJson = <T>(value: string, description: string): T => {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError("runtime_error", `Unable to parse ${description}: ${message}`);
  }
};

const assertWorkspaceLinks = async (
  runCommand: DockerCommandRunner,
  dockerCommand: string,
  containerName: string
): Promise<void> => {
  for (const relativePath of ["scratch", "team-dropbox"]) {
    const linkPath = path.posix.join(PICOCLAW_WORKSPACE, relativePath);
    await dockerExec(runCommand, dockerCommand, containerName, ["test", "-L", linkPath]);
    await dockerExec(runCommand, dockerCommand, containerName, [
      "sh",
      "-lc",
      `test -d "$(readlink '${linkPath}')"`
    ]);
  }

  await dockerExec(runCommand, dockerCommand, containerName, [
    "test",
    "-f",
    path.posix.join(PICOCLAW_WORKSPACE, "AGENTS.md")
  ]);
  await assertPicoClawWorkspace(runCommand, dockerCommand, containerName);
};

const waitForOperationalState = async (
  runCommand: DockerCommandRunner,
  dockerCommand: string,
  containerName: string,
  pollOptions: PollOptions,
  logger: OperationalSmokeLogger
): Promise<void> => {
  logger.info("operational-smoke: waiting for PicoClaw API");
  await poll("PicoClaw API", pollOptions, async () => {
    await dockerCurl(runCommand, dockerCommand, containerName, `http://127.0.0.1:${PICOCLAW_PORT}/health`);
    return true;
  });

  logger.info("operational-smoke: starting PicoClaw mock model");
  await startPicoClawMockModelServer(
    runCommand,
    dockerCommand,
    containerName,
    pollOptions,
    poll
  );

  logger.info("operational-smoke: waiting for Moltnet API");
  await poll("Moltnet API", pollOptions, async () => {
    await dockerCurl(runCommand, dockerCommand, containerName, `http://127.0.0.1:${MOLTNET_PORT}/healthz`);
    return true;
  });

  logger.info("operational-smoke: checking Moltnet agent attachment");
  await poll("Moltnet scheduled-agent attachment", pollOptions, async () => {
    const rawAgents = await dockerCurl(
      runCommand,
      dockerCommand,
      containerName,
      `http://127.0.0.1:${MOLTNET_PORT}/v1/agents`
    );
    const { agents } = parseJson<{ agents?: Array<{ id: string; rooms?: string[] }> }>(
      rawAgents,
      "Moltnet agents"
    );
    return agents?.some(
      (agent) => agent.id === "pico-scheduled" && (agent.rooms ?? []).includes("ops-room")
    )
      ? true
      : null;
  });

  logger.info("operational-smoke: checking workspace links");
  await assertWorkspaceLinks(runCommand, dockerCommand, containerName);

  logger.info("operational-smoke: waiting for PicoClaw cron-fired agent reply");
  await waitForPicoClawSchedule(runCommand, dockerCommand, containerName, pollOptions, poll);
};

const runSpawnfileUpCommand = async (
  input: {
    containerName: string;
    dockerCommand: string;
    fixtureDirectory: string;
    imageTag: string;
    logger: OperationalSmokeLogger;
    outputDirectory: string;
  },
  deps: {
    runCli: typeof runCli;
    upProject: typeof upProject;
  }
): Promise<UpProjectResult> => {
  let buildResult: UpProjectResult | undefined;
  const args = [
    "up",
    input.fixtureDirectory,
    "--detach",
    "--name",
    input.containerName,
    "--out",
    input.outputDirectory,
    "--tag",
    input.imageTag
  ];
  if (input.dockerCommand !== "docker") {
    args.push("--docker-command", input.dockerCommand);
  }

  const exitCode = await deps.runCli(
    args,
    {
      stderr: (message) => input.logger.info(`spawnfile up stderr: ${message}`),
      stdout: (message) => input.logger.info(`spawnfile up: ${message}`)
    },
    {
      upProject: async (inputPath, options) => {
        buildResult = await deps.upProject(inputPath, options);
        return buildResult;
      }
    }
  );

  if (exitCode !== 0 || !buildResult) {
    throw new SpawnfileError("runtime_error", `spawnfile up exited with code ${exitCode}`);
  }

  return buildResult;
};

const cleanup = async (
  input: {
    buildResult?: UpProjectResult;
    dockerCommand: string;
    keepImages: boolean;
    removeDirectory: typeof removeDirectory;
    runCommand: DockerCommandRunner;
  }
): Promise<void> => {
  if (input.buildResult?.containerName) {
    await input.runCommand(input.dockerCommand, ["rm", "-f", input.buildResult.containerName])
      .catch(() => undefined);
  }

  if (input.buildResult && !input.keepImages) {
    await input.runCommand(input.dockerCommand, ["image", "rm", "-f", input.buildResult.imageTag])
      .catch(() => undefined);
  }

  for (const mount of input.buildResult?.report.container?.persistent_mounts ?? []) {
    await input.runCommand(input.dockerCommand, ["volume", "rm", "-f", mount.volume_name])
      .catch(() => undefined);
  }

  if (input.buildResult?.supportDirectory) {
    await input.removeDirectory(input.buildResult.supportDirectory);
  }
};

export const runOperationalSmokeE2E = async (
  options: RunOperationalSmokeE2EOptions = {},
  dependencies: OperationalSmokeDependencies = {}
): Promise<RunOperationalSmokeE2EResult> => {
  const deps = {
    removeDirectory: dependencies.removeDirectory ?? removeDirectory,
    runCli: dependencies.runCli ?? runCli,
    runDockerCommand: dependencies.runDockerCommand ?? runDockerCommand,
    sleep: dependencies.sleep ?? sleep,
    upProject: dependencies.upProject ?? upProject
  };
  const logger = loggerFor(options.logger);
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-e2e-operational-smoke-"));
  const dockerCommand = options.dockerCommand ?? "docker";
  const outputDirectory = options.outputDirectory ?? path.join(root, "dist");
  let buildResult: UpProjectResult | undefined;

  try {
    logger.info("operational-smoke: running spawnfile up");
    buildResult = await runSpawnfileUpCommand({
      containerName: options.containerName ?? "spawnfile-e2e-operational-smoke",
      dockerCommand,
      fixtureDirectory: options.fixtureDirectory ?? DEFAULT_FIXTURE_DIRECTORY,
      imageTag: options.imageTag ?? `spawnfile-e2e-operational-smoke-${Date.now()}`,
      logger,
      outputDirectory
    }, deps);

    if (!buildResult.containerName) {
      throw new SpawnfileError("runtime_error", "spawnfile up did not return a container name");
    }

    await waitForOperationalState(
      deps.runDockerCommand,
      dockerCommand,
      buildResult.containerName,
      {
        intervalMs: options.pollIntervalMs ?? 2_000,
        sleep: deps.sleep,
        timeoutMs: options.timeoutMs ?? 180_000
      },
      logger
    );

    return {
      containerName: buildResult.containerName,
      imageTag: buildResult.imageTag,
      outputDirectory: buildResult.outputDirectory
    };
  } catch (error) {
    const logs = buildResult?.containerName
      ? await deps.runDockerCommand(dockerCommand, ["logs", buildResult.containerName]).catch(() => "")
      : "";
    const message = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError(
      isSpawnfileError(error) ? error.code : "runtime_error",
      `${message}${logs ? `\n\nDocker logs:\n${logs}` : ""}`
    );
  } finally {
    await cleanup({
      buildResult,
      dockerCommand,
      keepImages: options.keepImages ?? false,
      removeDirectory: deps.removeDirectory,
      runCommand: deps.runDockerCommand
    });
    if (!options.keepArtifacts) {
      await deps.removeDirectory(root);
    }
  }
};
