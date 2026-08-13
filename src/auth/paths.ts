import os from "node:os";
import path from "node:path";

const DEFAULT_SPAWNFILE_HOME = "~/.spawnfile";
const OPAQUE_TARGET_SECRET_HANDLE_PATTERN = /^opaque_[a-z0-9]{16,64}$/u;

const assertCanonicalTargetSecretKey = (targetSecretKey: string): void => {
  if (!OPAQUE_TARGET_SECRET_HANDLE_PATTERN.test(targetSecretKey)) {
    throw new Error("Invalid target-secret path key");
  }
};

const resolveTargetSecretLeafPath = (leafDirectory: string, targetSecretKey: string): string => {
  assertCanonicalTargetSecretKey(targetSecretKey);
  return path.join(leafDirectory, targetSecretKey);
};

const expandHomePath = (inputPath: string): string => {
  if (inputPath === "~") {
    return os.homedir();
  }

  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
};

export const resolveSpawnfileHome = (): string =>
  path.resolve(expandHomePath(process.env.SPAWNFILE_HOME ?? DEFAULT_SPAWNFILE_HOME));

export const resolveAuthHome = (): string => path.join(resolveSpawnfileHome(), "auth");

export const resolveProfilesRoot = (): string => path.join(resolveAuthHome(), "profiles");

export const resolveProfileDirectory = (profileName: string): string =>
  path.join(resolveProfilesRoot(), profileName);

export const resolveProfilePath = (profileName: string): string =>
  path.join(resolveProfileDirectory(profileName), "profile.json");

export const resolveImportedAuthDirectory = (
  profileName: string,
  kind: "claude-code" | "codex"
): string => path.join(resolveProfileDirectory(profileName), "imports", kind);

export const resolveTargetSecretsRoot = (): string =>
  path.join(resolveAuthHome(), "target-secrets");

export const resolveTargetSecretVersionsDirectory = (): string =>
  path.join(resolveTargetSecretsRoot(), "versions");

export const resolveTargetSecretVersionPath = (versionKey: string): string =>
  resolveTargetSecretLeafPath(resolveTargetSecretVersionsDirectory(), versionKey);

export const resolveTargetSecretGrantsDirectory = (): string =>
  path.join(resolveTargetSecretsRoot(), "grants");

export const resolveTargetSecretGrantPath = (grantKey: string): string =>
  resolveTargetSecretLeafPath(resolveTargetSecretGrantsDirectory(), grantKey);

export const resolveTargetSecretRedemptionsDirectory = (): string =>
  path.join(resolveTargetSecretsRoot(), "redemptions");

export const resolveTargetSecretRedemptionPath = (redemptionKey: string): string =>
  resolveTargetSecretLeafPath(resolveTargetSecretRedemptionsDirectory(), redemptionKey);

export const resolveTargetSecretRevocationsDirectory = (): string =>
  path.join(resolveTargetSecretsRoot(), "revocations");

export const resolveTargetSecretRevocationPath = (revocationKey: string): string =>
  resolveTargetSecretLeafPath(resolveTargetSecretRevocationsDirectory(), revocationKey);

export const resolveTargetSecretAliasesDirectory = (): string =>
  path.join(resolveTargetSecretsRoot(), "aliases");

export const resolveTargetSecretAliasPath = (aliasKey: string): string =>
  resolveTargetSecretLeafPath(resolveTargetSecretAliasesDirectory(), aliasKey);
