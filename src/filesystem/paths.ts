import path from "node:path";

import { SpawnfileError } from "../shared/index.js";

const INVALID_PATH_SEGMENT = "..";

export const assertPortableRelativePath = (inputPath: string): void => {
  if (path.isAbsolute(inputPath)) {
    throw new SpawnfileError(
      "validation_error",
      `Absolute paths are not allowed: ${inputPath}`
    );
  }

  const segments = inputPath.split("/");
  if (segments.includes(INVALID_PATH_SEGMENT)) {
    throw new SpawnfileError(
      "validation_error",
      `Path traversal is not allowed: ${inputPath}`
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
  const resolved = path.resolve(projectRoot, relativePath);

  if (!resolved.startsWith(projectRoot + path.sep) && resolved !== projectRoot) {
    throw new SpawnfileError(
      "validation_error",
      `Path escapes project root: ${relativePath}`
    );
  }

  return resolved;
};

export const toPosixPath = (value: string): string => value.split(path.sep).join("/");
