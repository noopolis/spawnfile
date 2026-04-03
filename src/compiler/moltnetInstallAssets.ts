import crypto from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { ensureDirectory } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";

const execFile = promisify(execFileCallback);

const MOLTNET_SOURCE_ROOT = path.resolve(process.cwd(), "moltnet");
const MOLTNET_INSTALL_SCRIPT_SOURCE = path.join(
  MOLTNET_SOURCE_ROOT,
  "website",
  "public",
  "install.sh"
);
export const MOLTNET_INSTALL_DIRECTORY = "moltnet-install";
const MOLTNET_TARGET_OS = "linux";
const MOLTNET_BINARY_NAMES = ["moltnet", "moltnet-node", "moltnet-bridge"] as const;

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

const hashFileSha256 = async (filePath: string): Promise<string> => {
  const content = await readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
};

const buildMoltnetBinary = async (
  commandName: (typeof MOLTNET_BINARY_NAMES)[number],
  outputPath: string,
  architecture: string,
  goCacheDirectory: string
): Promise<void> => {
  try {
    await execFile(
      process.env.GO ?? "go",
      ["build", "-buildvcs=false", "-o", outputPath, `./cmd/${commandName}`],
      {
        cwd: MOLTNET_SOURCE_ROOT,
        env: {
          ...process.env,
          CGO_ENABLED: "0",
          GOCACHE: goCacheDirectory,
          GOARCH: architecture,
          GOOS: MOLTNET_TARGET_OS
        }
      }
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError(
      "compile_error",
      `Unable to build Moltnet binary ${commandName}: ${reason}`
    );
  }
};

export const stageMoltnetInstallAssets = async (outputDirectory: string): Promise<void> => {
  const installDirectory = path.join(outputDirectory, MOLTNET_INSTALL_DIRECTORY);
  const architecture = resolveTargetArchitecture();
  const assetName = createReleaseAssetName(architecture);
  const checksumsPath = path.join(installDirectory, "checksums.txt");
  const archivePath = path.join(installDirectory, assetName);
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-moltnet-install-"));
  const goCacheDirectory = path.join(temporaryDirectory, "go-cache");

  await ensureDirectory(installDirectory);
  await ensureDirectory(goCacheDirectory);
  await copyFile(MOLTNET_INSTALL_SCRIPT_SOURCE, path.join(installDirectory, "install.sh"));

  try {
    await Promise.all(
      MOLTNET_BINARY_NAMES.map((binaryName) =>
        buildMoltnetBinary(
          binaryName,
          path.join(temporaryDirectory, binaryName),
          architecture,
          goCacheDirectory
        )
      )
    );

    await execFile("tar", [
      "-C",
      temporaryDirectory,
      "-czf",
      archivePath,
      ...MOLTNET_BINARY_NAMES
    ]);

    const archiveSha256 = await hashFileSha256(archivePath);
    await writeFile(checksumsPath, `${archiveSha256}  ${assetName}\n`, "utf8");
  } catch (error) {
    if (error instanceof SpawnfileError) {
      throw error;
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError(
      "compile_error",
      `Unable to stage Moltnet install assets: ${reason}`
    );
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
};
