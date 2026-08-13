import { execFile as execFileCallback } from "node:child_process";

import type { BuildImageCacheEntry } from "../deployment/buildImageCacheStore.js";

export const DOCKER_IMAGE_INSPECT_MAX_OUTPUT_BYTES = 64 * 1024;
export const DOCKER_IMAGE_INSPECT_TIMEOUT_MS = 5_000;

export interface DockerImageInspection {
  id: string;
  labels: Record<string, string>;
}

export interface DockerImageInspectInput {
  dockerCommand?: string;
  dockerContext?: string | null;
  imageTag: string;
}

export interface DockerImageInspectCommandOptions {
  encoding: "utf8";
  maxBuffer: number;
  timeout: number;
}

export type DockerImageInspectCommandRunner = (
  command: string,
  args: string[],
  options: DockerImageInspectCommandOptions
) => Promise<{ stdout: string }>;

export type DockerImageInspector = (
  input: DockerImageInspectInput
) => Promise<DockerImageInspection | null>;

const runDockerImageInspectCommand: DockerImageInspectCommandRunner = async (
  command,
  args,
  options
) =>
  new Promise<{ stdout: string }>((resolve, reject) => {
    execFileCallback(command, args, options, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout });
    });
  });

const parseDockerImageInspection = (source: string): DockerImageInspection | null => {
  try {
    const parsed = JSON.parse(source) as {
      id?: unknown;
      labels?: unknown;
    };
    if (typeof parsed.id !== "string" || parsed.id.length === 0) {
      return null;
    }
    if (parsed.labels === null || parsed.labels === undefined) {
      return { id: parsed.id, labels: {} };
    }
    if (typeof parsed.labels !== "object" || Array.isArray(parsed.labels)) {
      return null;
    }
    const labels = Object.fromEntries(
      Object.entries(parsed.labels).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );
    if (Object.keys(labels).length !== Object.keys(parsed.labels).length) {
      return null;
    }
    return { id: parsed.id, labels };
  } catch {
    return null;
  }
};

export const createDockerImageInspector = (
  runner: DockerImageInspectCommandRunner = runDockerImageInspectCommand
): DockerImageInspector =>
  async (input): Promise<DockerImageInspection | null> => {
    const args = input.dockerContext
      ? ["--context", input.dockerContext, "image", "inspect", input.imageTag]
      : ["image", "inspect", input.imageTag];
    args.push(
      "--format",
      '{"id":{{json .Id}},"labels":{{json .Config.Labels}}}'
    );

    try {
      const { stdout } = await runner(input.dockerCommand ?? "docker", args, {
        encoding: "utf8",
        maxBuffer: DOCKER_IMAGE_INSPECT_MAX_OUTPUT_BYTES,
        timeout: DOCKER_IMAGE_INSPECT_TIMEOUT_MS
      });
      if (Buffer.byteLength(stdout) > DOCKER_IMAGE_INSPECT_MAX_OUTPUT_BYTES) {
        return null;
      }
      return parseDockerImageInspection(stdout);
    } catch {
      return null;
    }
  };

export const inspectDockerImage = createDockerImageInspector();

export interface DockerBuildSkipInput extends DockerImageInspectInput {
  cacheEntry: BuildImageCacheEntry | null;
  compileFingerprint: string;
  contextDigest: string;
  imageInspector?: DockerImageInspector;
}

export const shouldSkipDockerBuild = async (
  input: DockerBuildSkipInput
): Promise<boolean> => {
  const entry = input.cacheEntry;
  if (!entry) {
    return false;
  }
  if (entry.contextDigest !== input.contextDigest) {
    return false;
  }
  if (entry.imageTag !== input.imageTag) {
    return false;
  }
  if (entry.compileFingerprint !== input.compileFingerprint) {
    return false;
  }
  if (entry.dockerContext !== (input.dockerContext ?? null)) {
    return false;
  }

  try {
    const inspection = await (input.imageInspector ?? inspectDockerImage)(input);
    return inspection?.id === entry.imageId
      && inspection.labels["com.spawnfile.compile_fingerprint"] === entry.compileFingerprint;
  } catch {
    return false;
  }
};
