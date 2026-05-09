import path from "node:path";

import { SpawnfileError } from "../shared/index.js";

export const assertPortableRelativePath = (inputPath: string): void => {
  if (inputPath.includes("\\")) {
    throw new SpawnfileError(
      "validation_error",
      `Paths must use forward slashes: ${inputPath}`
    );
  }

  if (path.isAbsolute(inputPath)) {
    throw new SpawnfileError(
      "validation_error",
      `Absolute paths are not allowed: ${inputPath}`
    );
  }
};

export const getCanonicalManifestPath = (filePath: string): string =>
  path.resolve(filePath);

export const getManifestPath = (inputPath: string): string =>
  path.basename(inputPath) === "Spawnfile"
    ? path.resolve(inputPath)
    : path.resolve(inputPath, "Spawnfile");

export const getProjectRoot = (manifestPath: string): string =>
  path.dirname(manifestPath);

export const resolveProjectPath = (
  manifestPath: string,
  relativePath: string
): string => {
  assertPortableRelativePath(relativePath);
  const projectRoot = getProjectRoot(manifestPath);
  return path.resolve(projectRoot, relativePath);
};

export const toPosixPath = (value: string): string => value.split(path.sep).join("/");
