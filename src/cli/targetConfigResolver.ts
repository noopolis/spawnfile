import path from "node:path";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";

import { parseImageReference } from "../distribution/index.js";
import { SpawnfileError } from "../shared/index.js";
import {
  defaultDockerTargetExecFile,
  resolveDockerContextEndpoint,
} from "../target/dockerTargetBinding.js";
import type { DockerTargetExecFile } from "../target/dockerTarget.js";

import {
  parseTargetPreparedArtifactMappings,
  type PreparedArtifactMapping,
} from "./targetDefaultConfig.js";
import { TARGET_DEFAULT_CONFIG_STDIN_VERSION } from "./targetDefaultConfigStdin.js";

export const TARGET_CONFIG_RESOLUTION_VERSION =
  "spawnfile.target-config-resolution.v1" as const;
export const STANDARD_WORLD_BASE_IMAGE = "node:22-bookworm-slim";

const CONTEXT = /^[a-z][a-z0-9_-]{0,63}$/u;
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CONFIG_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_PATH_BYTES = 4_096;
const MAX_REFERENCE_BYTES = 512;
const MAX_DOCKER_OUTPUT_BYTES = 64 * 1_024;
const MAX_PREPARED_PLAN_BYTES = 128 * 1_024;

export interface ResolveTargetConfigInput {
  readonly allowRemotePull?: boolean;
  readonly baseImage?: string;
  readonly context?: string;
  readonly dockerCommand?: string;
  readonly evidenceDestination: string;
  readonly execFile?: DockerTargetExecFile;
  readonly preparedPlanPath?: string;
  readonly pull?: boolean;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface TargetConfigResolution {
  readonly base_image: {
    readonly config_digest: `sha256:${string}`;
    readonly reference: string;
  };
  readonly endpoint: {
    readonly class: "local" | "remote";
    readonly transport: "fd" | "http" | "https" | "npipe" | "ssh" | "tcp" | "unix";
  };
  readonly context_selection: "auto-local" | "explicit";
  readonly platform: {
    readonly architecture: "amd64" | "arm64";
    readonly os: "linux";
  };
  readonly target_config: {
    readonly context: string;
    readonly dockerCommand: string;
    readonly evidenceDestination: string;
    readonly preparedArtifactMappings?: readonly PreparedArtifactMapping[];
    readonly timeoutMs: number;
    readonly version: typeof TARGET_DEFAULT_CONFIG_STDIN_VERSION;
  };
  readonly version: typeof TARGET_CONFIG_RESOLUTION_VERSION;
}

const validationFailure = (message: string): never => {
  throw new SpawnfileError("validation_error", message);
};

const runtimeFailure = (message: string): never => {
  throw new SpawnfileError("runtime_error", message);
};

const parseContext = (value: unknown): string =>
  typeof value === "string" && CONTEXT.test(value)
    ? value
    : validationFailure("Docker context must be an explicit bounded context name");

const parseDockerCommand = (value: unknown): string => {
  if (typeof value !== "string" || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > 1_024) {
    return validationFailure("Docker command is invalid");
  }
  if (COMMAND_NAME.test(value)) return value;
  if (path.isAbsolute(value) && path.normalize(value) === value) return value;
  return validationFailure("Docker command is invalid");
};

const parseTimeout = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 120_000
    ? value
    : validationFailure("Target timeout must be an integer from 1 to 120000 milliseconds");

const parseBaseImage = (value: unknown): string => {
  if (typeof value !== "string" || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > MAX_REFERENCE_BYTES
    || CONFIG_DIGEST.test(value) || parseImageReference(value) === null) {
    return validationFailure("Base image must be an explicit portable image reference");
  }
  return value;
};

const validateEvidenceDestination = async (value: unknown): Promise<string> => {
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

const parsePreparedPlanPath = (value: unknown): string => {
  if (typeof value !== "string" || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES
    || !path.isAbsolute(value) || path.normalize(value) !== value) {
    return validationFailure("Prepared target plan path must be absolute and normalized");
  }
  return value;
};

const readPreparedPlan = async (
  planPath: string | undefined,
  evidenceDestination: string
): Promise<readonly PreparedArtifactMapping[] | undefined> => {
  if (planPath === undefined) return undefined;
  const resolved = parsePreparedPlanPath(planPath);
  const owner = process.getuid?.();
  let handle;
  try {
    const before = await lstat(resolved);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1
      || before.size > MAX_PREPARED_PLAN_BYTES || (before.mode & 0o777) !== 0o600
      || owner !== undefined && before.uid !== owner) {
      return validationFailure("Prepared target plan must be a private bounded regular file");
    }
    handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== bytes.byteLength) {
      return validationFailure("Prepared target plan changed while it was read");
    }
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return validationFailure("Prepared target plan must be UTF-8 JSON");
    }
    const parsed = JSON.parse(source) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).sort().join("\0")
        !== "evidence_destination\0prepared_artifact_mapping") {
      return validationFailure("Prepared target plan has an invalid shape");
    }
    const value = parsed as Record<string, unknown>;
    if (value.evidence_destination !== evidenceDestination) {
      return validationFailure("Prepared target plan evidence destination does not match");
    }
    try {
      return parseTargetPreparedArtifactMappings([value.prepared_artifact_mapping]);
    } catch {
      return validationFailure("Prepared target plan artifact mapping is invalid");
    }
  } catch (error) {
    if (error instanceof SpawnfileError) throw error;
    return validationFailure("Prepared target plan is unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

type EndpointTransport = TargetConfigResolution["endpoint"]["transport"];

const classifyEndpoint = (
  endpoint: string
): TargetConfigResolution["endpoint"] => {
  if (Buffer.byteLength(endpoint, "utf8") > 4_096 || /\s/u.test(endpoint)) {
    return runtimeFailure("Docker context returned an invalid endpoint");
  }
  const match = /^(fd|http|https|npipe|ssh|tcp|unix):\/\/.+$/u.exec(endpoint);
  if (!match) return runtimeFailure("Docker context returned an unsupported endpoint transport");
  const transport = match[1] as EndpointTransport;
  return Object.freeze({
    class: transport === "fd" || transport === "npipe" || transport === "unix"
      ? "local" as const
      : "remote" as const,
    transport,
  });
};

const normalizeArchitecture = (value: unknown): "amd64" | "arm64" => {
  if (typeof value !== "string") return runtimeFailure("Docker architecture is invalid");
  switch (value.trim()) {
    case "amd64":
    case "x64":
    case "x86_64":
      return "amd64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return runtimeFailure("Docker architecture is unsupported");
  }
};

const exactJson = (
  source: string,
  keys: readonly string[],
  failureMessage: string
): Record<string, unknown> => {
  if (Buffer.byteLength(source, "utf8") > MAX_DOCKER_OUTPUT_BYTES) {
    return runtimeFailure(failureMessage);
  }
  try {
    const parsed = JSON.parse(source) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).sort().join("\0") !== [...keys].sort().join("\0")) {
      return runtimeFailure(failureMessage);
    }
    return parsed as Record<string, unknown>;
  } catch {
    return runtimeFailure(failureMessage);
  }
};

const executeDocker = async (
  execFile: DockerTargetExecFile,
  command: string,
  context: string,
  args: string[],
  timeout: number,
  signal: AbortSignal | undefined,
  failureMessage: string
): Promise<string> => {
  try {
    const result = await execFile(command, ["--context", context, ...args], { signal, timeout });
    if (Buffer.byteLength(result.stdout, "utf8") > MAX_DOCKER_OUTPUT_BYTES) {
      return runtimeFailure(failureMessage);
    }
    return result.stdout;
  } catch {
    return runtimeFailure(failureMessage);
  }
};

const resolveCurrentDockerContext = async (
  execFile: DockerTargetExecFile,
  dockerCommand: string,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<string> => {
  try {
    const result = await execFile(dockerCommand, ["context", "show"], {
      signal,
      timeout: timeoutMs,
    });
    if (Buffer.byteLength(result.stdout, "utf8") > 4_096) {
      return runtimeFailure("Current Docker context is invalid");
    }
    return parseContext(result.stdout.trim());
  } catch (error) {
    if (error instanceof SpawnfileError) throw error;
    return runtimeFailure("Unable to resolve the current Docker context");
  }
};

export const resolveTargetConfig = async (
  input: ResolveTargetConfigInput
): Promise<TargetConfigResolution> => {
  const baseImage = parseBaseImage(input.baseImage ?? STANDARD_WORLD_BASE_IMAGE);
  const dockerCommand = parseDockerCommand(input.dockerCommand ?? "docker");
  const timeoutMs = parseTimeout(input.timeoutMs ?? 10_000);
  const evidenceDestination = await validateEvidenceDestination(input.evidenceDestination);
  const preparedArtifactMappings = await readPreparedPlan(
    input.preparedPlanPath,
    evidenceDestination
  );
  const execFile = input.execFile ?? defaultDockerTargetExecFile;
  const contextSelection = input.context === undefined ? "auto-local" as const : "explicit" as const;
  const context = input.context === undefined
    ? await resolveCurrentDockerContext(execFile, dockerCommand, timeoutMs, input.signal)
    : parseContext(input.context);
  let endpointValue: string;
  try {
    endpointValue = await resolveDockerContextEndpoint(context, {
      dockerCommand, execFile, signal: input.signal, timeoutMs,
    });
  } catch {
    return runtimeFailure(`Unable to inspect Docker context "${context}"`);
  }
  const endpoint = classifyEndpoint(endpointValue);
  if (contextSelection === "auto-local" && endpoint.class !== "local") {
    return validationFailure(
      "Current Docker context is remote; pass --context explicitly to select a remote target"
    );
  }
  if (input.pull === true && endpoint.class === "remote" && input.allowRemotePull !== true) {
    return validationFailure("Pulling on a remote Docker context requires --allow-remote-pull");
  }

  const infoSource = await executeDocker(
    execFile, dockerCommand, context,
    ["info", "--format", "{\"Architecture\":{{json .Architecture}},\"OSType\":{{json .OSType}}}"],
    timeoutMs, input.signal, "Unable to inspect Docker target platform"
  );
  const info = exactJson(infoSource, ["Architecture", "OSType"], "Docker target platform is invalid");
  if (info.OSType !== "linux") return runtimeFailure("Docker target operating system is unsupported");
  const architecture = normalizeArchitecture(info.Architecture);

  if (input.pull === true) {
    await executeDocker(
      execFile, dockerCommand, context, ["image", "pull", "--quiet", baseImage],
      timeoutMs, input.signal, "Unable to pull the requested base image"
    );
  }
  const imageSource = await executeDocker(
    execFile, dockerCommand, context,
    ["image", "inspect", baseImage, "--format",
      "{\"Architecture\":{{json .Architecture}},\"Id\":{{json .Id}},\"Os\":{{json .Os}}}"],
    timeoutMs, input.signal,
    input.pull === true
      ? "Unable to inspect the pulled base image"
      : "Base image is unavailable in the Docker context; rerun with --pull to fetch it"
  );
  const image = exactJson(
    imageSource, ["Architecture", "Id", "Os"], "Docker base image inspection is invalid"
  );
  const imageArchitecture = normalizeArchitecture(image.Architecture);
  if (image.Os !== "linux" || imageArchitecture !== architecture) {
    return runtimeFailure("Docker base image platform does not match the selected target");
  }
  if (typeof image.Id !== "string" || !CONFIG_DIGEST.test(image.Id)) {
    return runtimeFailure("Docker base image config ID is invalid");
  }

  return Object.freeze({
    base_image: Object.freeze({
      config_digest: image.Id as `sha256:${string}`,
      reference: baseImage,
    }),
    context_selection: contextSelection,
    endpoint,
    platform: Object.freeze({ architecture, os: "linux" as const }),
    target_config: Object.freeze({
      context,
      dockerCommand,
      evidenceDestination,
      ...(preparedArtifactMappings === undefined ? {} : { preparedArtifactMappings }),
      timeoutMs,
      version: TARGET_DEFAULT_CONFIG_STDIN_VERSION,
    }),
    version: TARGET_CONFIG_RESOLUTION_VERSION,
  });
};

export const createTargetConfigResolutionBytes = (
  resolution: TargetConfigResolution
): string => JSON.stringify(resolution);
