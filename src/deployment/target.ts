import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { SpawnfileError } from "../shared/index.js";

const execFile = promisify(execFileCallback);

export type DockerDeploymentTarget =
  | {
      endpoint_fingerprint: string;
      kind: "context";
      name: string;
    }
  | {
      endpoint_fingerprint: string;
      kind: "docker-context";
      context: string;
    }
  | {
      kind: "host";
      value: string;
    };

export type DockerTargetExecFile = (
  file: string,
  args: string[],
  options: { timeout: number }
) => Promise<{ stderr: string; stdout: string }>;

export interface ResolveDockerDeploymentTargetOptions {
  context?: string | null;
  dockerCommand?: string;
  dockerHost?: string | null;
  execFile?: DockerTargetExecFile;
  timeoutMs?: number;
}

export const createEndpointFingerprint = (endpoint: string): string => {
  const normalized = endpoint.trim();
  if (normalized.length === 0) {
    throw new SpawnfileError("validation_error", "Deployment target endpoint must not be empty");
  }

  return `sha256:${createHash("sha256").update(normalized).digest("hex").slice(0, 32)}`;
};

const parseDockerEndpoint = (stdout: string): string => {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new SpawnfileError("runtime_error", "Docker context endpoint was empty");
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string" && parsed.trim().length > 0) {
      return parsed.trim();
    }
  } catch {
    // Docker/podman variants may return a plain string instead of JSON.
  }

  return trimmed;
};

const resolveDockerContextEndpoint = async (
  context: string,
  options: Required<Pick<ResolveDockerDeploymentTargetOptions, "dockerCommand" | "execFile" | "timeoutMs">>
): Promise<string> => {
  try {
    const { stdout } = await options.execFile(
      options.dockerCommand,
      ["context", "inspect", context, "--format", "{{json .Endpoints.docker.Host}}"],
      { timeout: options.timeoutMs }
    );
    return parseDockerEndpoint(stdout);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError(
      "runtime_error",
      `Unable to resolve Docker context "${context}": ${reason}`
    );
  }
};

export const createDockerDeploymentTarget = (input: {
  context?: string;
  endpoint?: string;
  host?: string;
}): DockerDeploymentTarget => {
  const host = input.host?.trim();
  if (host) {
    return {
      kind: "host",
      value: host
    };
  }

  const context = input.context?.trim();
  const endpoint = input.endpoint?.trim();
  if (!context || !endpoint) {
    throw new SpawnfileError(
      "validation_error",
      "Docker context deployment targets require both context and endpoint"
    );
  }

  return {
    name: context,
    endpoint_fingerprint: createEndpointFingerprint(endpoint),
    kind: "context"
  };
};

export const dockerContextNameForTarget = (
  target: DockerDeploymentTarget
): string | null =>
  target.kind === "context"
    ? target.name
    : target.kind === "docker-context"
      ? target.context
      : null;

export const dockerHostValueForTarget = (
  target: DockerDeploymentTarget
): string | null =>
  target.kind === "host" ? target.value : null;

export const resolveDockerDeploymentTarget = async (
  input: ResolveDockerDeploymentTargetOptions = {}
): Promise<DockerDeploymentTarget> => {
  const explicitContext = input.context?.trim();
  const host = explicitContext ? undefined : input.dockerHost?.trim() ?? process.env.DOCKER_HOST?.trim();
  if (host) {
    return createDockerDeploymentTarget({ host });
  }

  const resolvedOptions = {
    dockerCommand: input.dockerCommand ?? "docker",
    execFile: input.execFile ?? execFile,
    timeoutMs: input.timeoutMs ?? 10_000
  };
  const context = explicitContext || "default";
  const endpoint = await resolveDockerContextEndpoint(context, resolvedOptions);
  return createDockerDeploymentTarget({ context, endpoint });
};

export const verifyDockerDeploymentTarget = async (
  target: DockerDeploymentTarget,
  options: Omit<ResolveDockerDeploymentTargetOptions, "context" | "dockerHost"> = {}
): Promise<string | null> => {
  if (target.kind === "host") {
    return null;
  }

  const context = dockerContextNameForTarget(target);
  if (!context) {
    return null;
  }

  const current = await resolveDockerDeploymentTarget({
    ...options,
    context
  });
  const currentFingerprint = current.kind === "host" ? null : current.endpoint_fingerprint;
  if (currentFingerprint !== target.endpoint_fingerprint) {
    throw new SpawnfileError(
      "runtime_error",
      `Docker context "${context}" endpoint changed since deployment`
    );
  }

  return context;
};
