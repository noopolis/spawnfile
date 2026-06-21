import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { chmod } from "node:fs/promises";
import { promisify } from "node:util";

import { ensureDirectory, fileExists } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";

const execFile = promisify(execFileCallback);

const MOLTNET_CLI_ENV = "SPAWNFILE_MOLTNET_CLI";
const MOLTNET_RELEASE_DIR_ENV = "SPAWNFILE_MOLTNET_RELEASE_DIR";
const MOLTNET_TARGET_ARCH_ENV = "SPAWNFILE_MOLTNET_TARGET_ARCH";
const LOCAL_MOLTNET_CLI_PATH = path.resolve(process.cwd(), "moltnet", "bin", "moltnet");
const MOLTNET_TARGET_OS = "linux";

export const MOLTNET_BIN_DIRECTORY = "moltnet-bin";
export const MOLTNET_BINARY_NAMES = ["moltnet"] as const;
export type MoltnetTargetArchitecture = "amd64" | "arm64";

const normalizeTargetArchitecture = (architecture: string): MoltnetTargetArchitecture => {
  switch (architecture) {
    case "amd64":
    case "x86_64":
    case "x64":
      return "amd64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      throw new SpawnfileError(
        "compile_error",
        `Moltnet container installs do not support target architecture ${architecture}`
      );
  }
};

const resolveTargetArchitecture = (
  architecture?: MoltnetTargetArchitecture
): MoltnetTargetArchitecture => {
  if (architecture) {
    return architecture;
  }

  const configuredArchitecture = process.env[MOLTNET_TARGET_ARCH_ENV]?.trim();
  if (configuredArchitecture) {
    return normalizeTargetArchitecture(configuredArchitecture);
  }

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

const isCommandNotFoundError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";

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
      `Unable to execute compiled Moltnet CLI from ${sourceLabel}: ${reason}. Install Moltnet with \`curl -fsSL https://moltnet.dev/install.sh | sh\` or set ${MOLTNET_CLI_ENV}.`
    );
  }
};

const resolveConfiguredReleaseDirectory = async (): Promise<string | null> => {
  const configuredDirectory = process.env[MOLTNET_RELEASE_DIR_ENV]?.trim();
  if (!configuredDirectory) {
    return null;
  }

  if (!(await fileExists(configuredDirectory))) {
    throw new SpawnfileError(
      "compile_error",
      `Moltnet release directory ${configuredDirectory} does not exist`
    );
  }

  return configuredDirectory;
};

const findPathMoltnetCli = async (): Promise<string | null> => {
  try {
    await execFile("moltnet", ["version"]);
    return "moltnet";
  } catch (error) {
    if (isCommandNotFoundError(error)) {
      return null;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError(
      "compile_error",
      `Unable to execute compiled Moltnet CLI from PATH: ${reason}. Install Moltnet with \`curl -fsSL https://moltnet.dev/install.sh | sh\` or set ${MOLTNET_CLI_ENV}.`
    );
  }
};

export const resolveMoltnetCliCommand = async (): Promise<string> => {
  const configuredCli = process.env[MOLTNET_CLI_ENV]?.trim();
  if (configuredCli) {
    return validateMoltnetCli(configuredCli, configuredCli);
  }

  const pathCli = await findPathMoltnetCli();
  if (pathCli) {
    return pathCli;
  }

  if (await fileExists(LOCAL_MOLTNET_CLI_PATH)) {
    return validateMoltnetCli(LOCAL_MOLTNET_CLI_PATH, LOCAL_MOLTNET_CLI_PATH);
  }

  return validateMoltnetCli("moltnet", "PATH");
};

export const stageMoltnetBinaries = async (
  outputDirectory: string,
  options: { architecture?: MoltnetTargetArchitecture } = {}
): Promise<boolean> => {
  const releaseDirectory = await resolveConfiguredReleaseDirectory();
  if (!releaseDirectory) {
    return false;
  }

  const architecture = resolveTargetArchitecture(options.architecture);
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

  return true;
};
