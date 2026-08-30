import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { SpawnfileError } from "../shared/index.js";
import { parseDockerBaseImageReference } from "../target/dockerBaseImage.js";

import type { TargetConfigResolution } from "./targetConfigResolverContracts.js";

const CONTEXT = /^[a-z][a-z0-9_-]{0,63}$/u;
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_PATH_BYTES = 4_096;

export const validationFailure = (message: string): never => {
  throw new SpawnfileError("validation_error", message);
};
export const runtimeFailure = (message: string): never => {
  throw new SpawnfileError("runtime_error", message);
};
export const parseContext = (value: unknown): string =>
  typeof value === "string" && CONTEXT.test(value)
    ? value
    : validationFailure("Docker context must be an explicit bounded context name");
export const parseDockerCommand = (value: unknown): string => {
  if (typeof value !== "string" || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > 1_024) {
    return validationFailure("Docker command is invalid");
  }
  if (COMMAND_NAME.test(value)) return value;
  if (path.isAbsolute(value) && path.normalize(value) === value) return value;
  return validationFailure("Docker command is invalid");
};
export const parseTimeout = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 120_000
    ? value
    : validationFailure("Target timeout must be an integer from 1 to 120000 milliseconds");
export const parseBaseImage = (value: unknown): string => parseDockerBaseImageReference(value)
  ?? validationFailure("Base image must be an explicit portable image reference");

export const validateEvidenceDestination = async (value: unknown): Promise<string> => {
  if (typeof value !== "string" || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES
    || !path.isAbsolute(value) || path.normalize(value) !== value) {
    return validationFailure("Evidence destination must be an absolute normalized path");
  }
  const parent = path.dirname(value);
  const owner = process.getuid?.();
  try {
    const parentInfo = await lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()
      || (parentInfo.mode & 0o777) !== 0o700
      || owner !== undefined && parentInfo.uid !== owner
      || await realpath(parent) !== parent) {
      return validationFailure("Evidence destination parent must be a private physical directory");
    }
    try {
      const destinationInfo = await lstat(value);
      if (!destinationInfo.isFile() || destinationInfo.isSymbolicLink()
        || (destinationInfo.mode & 0o777) !== 0o600
        || owner !== undefined && destinationInfo.uid !== owner) {
        return validationFailure("Existing evidence destination must be a private regular file");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } catch (error) {
    if (error instanceof SpawnfileError) throw error;
    return validationFailure("Evidence destination parent is unavailable");
  }
  return value;
};

type EndpointTransport = TargetConfigResolution["endpoint"]["transport"];
export const classifyEndpoint = (endpoint: string): TargetConfigResolution["endpoint"] => {
  if (Buffer.byteLength(endpoint, "utf8") > 4_096 || /\s/u.test(endpoint)) {
    return runtimeFailure("Docker context returned an invalid endpoint");
  }
  const match = /^(fd|http|https|npipe|ssh|tcp|unix):\/\/.+$/u.exec(endpoint);
  if (!match) return runtimeFailure("Docker context returned an unsupported endpoint transport");
  const transport = match[1] as EndpointTransport;
  return Object.freeze({
    class: transport === "fd" || transport === "npipe" || transport === "unix"
      ? "local" as const : "remote" as const,
    transport,
  });
};
export const normalizeArchitecture = (value: unknown): "amd64" | "arm64" => {
  if (typeof value !== "string") return runtimeFailure("Docker architecture is invalid");
  switch (value.trim()) {
    case "amd64": case "x64": case "x86_64": return "amd64";
    case "aarch64": case "arm64": return "arm64";
    default: return runtimeFailure("Docker architecture is unsupported");
  }
};
