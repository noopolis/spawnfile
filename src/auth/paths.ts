import os from "node:os";
import path from "node:path";

const DEFAULT_SPAWNFILE_HOME = "~/.spawnfile";

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
