import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { chmod, readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { ensureDirectory, fileExists } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";
import {
  parseTrustedMoltnetReleaseAuthority,
  readTrustedMoltnetReleaseAuthority,
  trustedMoltnetReleaseAsset,
  type MoltnetTargetArchitecture,
  type TrustedMoltnetReleaseAuthority
} from "./moltnetReleaseAuthority.js";
import { downloadTrustedMoltnetReleaseAsset } from "./moltnetReleaseDownload.js";

const execFile = promisify(execFileCallback);

const MOLTNET_CLI_ENV = "SPAWNFILE_MOLTNET_CLI";
/** Explicit operator override for a locally staged, authority-bound release. */
export const MOLTNET_RELEASE_DIR_ENV = "SPAWNFILE_MOLTNET_RELEASE_DIR";
const MOLTNET_TARGET_ARCH_ENV = "SPAWNFILE_MOLTNET_TARGET_ARCH";
const MOLTNET_TARGET_OS = "linux";

export const MOLTNET_BIN_DIRECTORY = "moltnet-bin";
export const MOLTNET_BINARY_NAMES = ["moltnet"] as const;
export const MOLTNET_RELEASE_IDENTITY_VERSION = "spawnfile.moltnet-release-identity.v1" as const;
export const MOLTNET_RELEASE_STAMP_VERSION = "spawnfile.moltnet-release-stamp.v1" as const;
export type { MoltnetTargetArchitecture } from "./moltnetReleaseAuthority.js";

export interface MoltnetReleaseIdentity {
  readonly architecture: MoltnetTargetArchitecture;
  readonly asset: string;
  readonly asset_sha256: `sha256:${string}`;
  readonly capabilities: readonly ["pi-bridge"];
  readonly release_version: string;
  readonly source_revision: string;
  readonly version: typeof MOLTNET_RELEASE_IDENTITY_VERSION;
}

export interface MoltnetBinaryStageOptions {
  readonly architecture?: MoltnetTargetArchitecture;
  /** Explicit local source directory; bytes remain bound to trusted authority. */
  readonly releaseDirectory?: string;
}

interface MoltnetReleaseStamp {
  readonly arch: MoltnetTargetArchitecture;
  readonly asset: string;
  readonly built_at: string;
  readonly capabilities: readonly ["pi-bridge"];
  readonly pi_bridge: true;
  readonly sha256: string;
  readonly source_revision: string;
  readonly stamp_version: typeof MOLTNET_RELEASE_STAMP_VERSION;
  readonly version: string;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const PINNED_VERSION = /^v?\d+\.\d+\.\d+(?:-\d+-g[a-f0-9]{7,40})?$/u;

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

const createReleaseStampName = (architecture: string): string =>
  `moltnet_release_stamp_${architecture}.json`;

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

const parseReleaseStamp = (raw: string, architecture: MoltnetTargetArchitecture): MoltnetReleaseStamp => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SpawnfileError("compile_error", "Moltnet release capability stamp is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SpawnfileError("compile_error", "Moltnet release capability stamp has an invalid shape");
  }
  const value = parsed as Record<string, unknown>;
  const expectedKeys = [
    "arch", "asset", "built_at", "capabilities", "pi_bridge", "sha256",
    "source_revision", "stamp_version", "version"
  ];
  const capabilities = value.capabilities;
  if (!exactKeys(value, expectedKeys)
    || value.stamp_version !== MOLTNET_RELEASE_STAMP_VERSION
    || value.arch !== architecture
    || value.asset !== createReleaseAssetName(architecture)
    || typeof value.built_at !== "string"
    || !Number.isFinite(Date.parse(value.built_at))
    || !Array.isArray(capabilities)
    || capabilities.length !== 1
    || capabilities[0] !== "pi-bridge"
    || value.pi_bridge !== true
    || typeof value.sha256 !== "string"
    || !SHA256.test(value.sha256)
    || typeof value.source_revision !== "string"
    || !REVISION.test(value.source_revision)
    || typeof value.version !== "string"
    || !PINNED_VERSION.test(value.version)) {
    throw new SpawnfileError(
      "compile_error",
      `Moltnet release capability stamp must be strict, pinned, and assert only the pi-bridge capability for ${architecture}`
    );
  }
  const describedRevision = value.version.match(/-g([a-f0-9]{7,40})$/u)?.[1];
  if (describedRevision && !value.source_revision.startsWith(describedRevision)) {
    throw new SpawnfileError("compile_error", "Moltnet release version does not match its source revision");
  }
  return value as unknown as MoltnetReleaseStamp;
};

const verifyReleaseIdentity = async (
  releaseDirectory: string,
  architecture: MoltnetTargetArchitecture,
  authority: TrustedMoltnetReleaseAuthority
): Promise<MoltnetReleaseIdentity> => {
  const trustedAuthority = parseTrustedMoltnetReleaseAuthority(authority);
  const trustedAsset = trustedMoltnetReleaseAsset(trustedAuthority, architecture);
  const asset = createReleaseAssetName(architecture);
  const assetPath = path.join(releaseDirectory, asset);
  const stampPath = path.join(releaseDirectory, createReleaseStampName(architecture));
  if (!(await fileExists(assetPath))) {
    throw new SpawnfileError("compile_error", `Moltnet release asset ${assetPath} does not exist`);
  }
  if (!(await fileExists(stampPath))) {
    throw new SpawnfileError(
      "compile_error",
      `Moltnet release asset ${asset} has no required capability stamp ${stampPath}`
    );
  }
  const stamp = parseReleaseStamp((await readFile(stampPath)).toString("utf8"), architecture);
  const sha256 = createHash("sha256").update(await readFile(assetPath)).digest("hex");
  if (stamp.sha256 !== sha256) {
    throw new SpawnfileError(
      "compile_error",
      `Moltnet release stamp sha256 does not match ${asset} (stale or tampered artifact)`
    );
  }
  if (stamp.version !== trustedAuthority.release_version
    || stamp.source_revision !== trustedAuthority.source_revision
    || stamp.asset !== trustedAsset.asset
    || `sha256:${sha256}` !== trustedAsset.asset_sha256) {
    throw new SpawnfileError(
      "compile_error",
      `Moltnet release stamp and asset do not match trusted pinned authority for ${architecture}`
    );
  }
  return Object.freeze({
    architecture,
    asset,
    asset_sha256: `sha256:${sha256}`,
    capabilities: Object.freeze(["pi-bridge"] as const),
    release_version: stamp.version,
    source_revision: stamp.source_revision,
    version: MOLTNET_RELEASE_IDENTITY_VERSION
  });
};

const stageMoltnetReleaseAsset = async (
  outputDirectory: string,
  releaseAssetPath: string,
  identity: MoltnetReleaseIdentity
): Promise<MoltnetReleaseIdentity> => {
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

  return identity;
};

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

  return validateMoltnetCli("moltnet", "PATH");
};

const stageMoltnetBinariesAtReleaseDirectory = async (
  outputDirectory: string,
  releaseDirectory: string,
  options: { architecture?: MoltnetTargetArchitecture } = {}
): Promise<MoltnetReleaseIdentity> => {
  if (!path.isAbsolute(releaseDirectory) || !(await fileExists(releaseDirectory))) {
    throw new SpawnfileError("compile_error", "Trusted Moltnet release directory is invalid");
  }

  const architecture = resolveTargetArchitecture(options.architecture);
  const authority = await readTrustedMoltnetReleaseAuthority();
  const identity = await verifyReleaseIdentity(releaseDirectory, architecture, authority);
  const releaseAssetPath = path.join(
    releaseDirectory,
    createReleaseAssetName(architecture)
  );
  return stageMoltnetReleaseAsset(outputDirectory, releaseAssetPath, identity);
};

export const stageMoltnetBinaries = async (
  outputDirectory: string,
  options: MoltnetBinaryStageOptions = {}
): Promise<MoltnetReleaseIdentity> => {
  const releaseDirectory = options.releaseDirectory
    ?? await resolveConfiguredReleaseDirectory();
  if (releaseDirectory) {
    return stageMoltnetBinariesAtReleaseDirectory(
      outputDirectory,
      releaseDirectory,
      { architecture: options.architecture }
    );
  }
  const architecture = resolveTargetArchitecture(options.architecture);
  const authority = await readTrustedMoltnetReleaseAuthority();
  const trustedAsset = trustedMoltnetReleaseAsset(authority, architecture);
  const downloaded = await downloadTrustedMoltnetReleaseAsset(authority, architecture);
  try {
    return await stageMoltnetReleaseAsset(outputDirectory, downloaded.assetPath, Object.freeze({
      architecture,
      asset: trustedAsset.asset,
      asset_sha256: trustedAsset.asset_sha256,
      capabilities: Object.freeze(["pi-bridge"] as const),
      release_version: authority.release_version,
      source_revision: authority.source_revision,
      version: MOLTNET_RELEASE_IDENTITY_VERSION
    }));
  } finally {
    await downloaded.cleanup();
  }
};
