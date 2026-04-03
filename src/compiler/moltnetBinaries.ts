import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { chmod } from "node:fs/promises";
import { promisify } from "node:util";

import { ensureDirectory, fileExists } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";

const execFile = promisify(execFileCallback);

const MOLTNET_CLI_ENV = "SPAWNFILE_MOLTNET_CLI";
const MOLTNET_RELEASE_DIR_ENV = "SPAWNFILE_MOLTNET_RELEASE_DIR";
const LOCAL_MOLTNET_CLI_PATH = path.resolve(process.cwd(), "moltnet", "bin", "moltnet");
const LOCAL_MOLTNET_RELEASE_DIRECTORY = path.resolve(process.cwd(), "moltnet", "dist", "release");
const MOLTNET_TARGET_OS = "linux";

export const MOLTNET_BIN_DIRECTORY = "moltnet-bin";
export const MOLTNET_BINARY_NAMES = ["moltnet", "moltnet-node", "moltnet-bridge"] as const;

const resolveTargetArchitecture = (): string => {
  switch (process.arch) {
    case "arm64":
      return "arm64";
    case "x64":
      return "amd64";
    default:
      throw new SpawnfileError(
        "compile_error",
        `Moltnet container installs do not support host architecture ${process.arch}`
      );
  }
};

const createReleaseAssetName = (architecture: string): string =>
  `moltnet_${MOLTNET_TARGET_OS}_${architecture}.tar.gz`;

const validateMoltnetCli = async (
  command: string,
  sourceLabel: string
): Promise<string> => {
  try {
    await execFile(command, ["version"]);
    return command;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError(
      "compile_error",
      `Unable to execute compiled Moltnet CLI from ${sourceLabel}: ${reason}. Build Moltnet with \`cd moltnet && make build release-assets\` or set ${MOLTNET_CLI_ENV} and ${MOLTNET_RELEASE_DIR_ENV}.`
    );
  }
};

const resolveReleaseDirectory = async (): Promise<string> => {
  const configuredDirectory = process.env[MOLTNET_RELEASE_DIR_ENV]?.trim();
  if (configuredDirectory) {
    if (!(await fileExists(configuredDirectory))) {
      throw new SpawnfileError(
        "compile_error",
        `Moltnet release directory ${configuredDirectory} does not exist`
      );
    }
    return configuredDirectory;
  }

  if (await fileExists(LOCAL_MOLTNET_RELEASE_DIRECTORY)) {
    return LOCAL_MOLTNET_RELEASE_DIRECTORY;
  }

  throw new SpawnfileError(
    "compile_error",
    `Moltnet release assets were not found. Build them with \`cd moltnet && make build release-assets\` or set ${MOLTNET_RELEASE_DIR_ENV}.`
  );
};

export const resolveMoltnetCliCommand = async (): Promise<string> => {
  const configuredCli = process.env[MOLTNET_CLI_ENV]?.trim();
  if (configuredCli) {
    return validateMoltnetCli(configuredCli, configuredCli);
  }

  if (await fileExists(LOCAL_MOLTNET_CLI_PATH)) {
    return validateMoltnetCli(LOCAL_MOLTNET_CLI_PATH, LOCAL_MOLTNET_CLI_PATH);
  }

  return validateMoltnetCli("moltnet", "PATH");
};

export const stageMoltnetBinaries = async (outputDirectory: string): Promise<void> => {
  const releaseDirectory = await resolveReleaseDirectory();
  const architecture = resolveTargetArchitecture();
  const releaseAssetPath = path.join(
    releaseDirectory,
    createReleaseAssetName(architecture)
  );

  if (!(await fileExists(releaseAssetPath))) {
    throw new SpawnfileError(
      "compile_error",
      `Moltnet release asset ${releaseAssetPath} does not exist. Build it with \`cd moltnet && make release-assets\` or set ${MOLTNET_RELEASE_DIR_ENV}.`
    );
  }

  const installDirectory = path.join(outputDirectory, MOLTNET_BIN_DIRECTORY);
  await ensureDirectory(installDirectory);

  try {
    await execFile("tar", ["-C", installDirectory, "-xzf", releaseAssetPath]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError(
      "compile_error",
      `Unable to extract Moltnet release asset ${releaseAssetPath}: ${reason}`
    );
  }

  for (const binaryName of MOLTNET_BINARY_NAMES) {
    const binaryPath = path.join(installDirectory, binaryName);
    if (!(await fileExists(binaryPath))) {
      throw new SpawnfileError(
        "compile_error",
        `Moltnet release asset ${releaseAssetPath} did not contain ${binaryName}`
      );
    }
    await chmod(binaryPath, 0o755);
  }
};
