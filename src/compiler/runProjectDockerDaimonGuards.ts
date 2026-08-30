import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { SpawnfileError } from "../shared/index.js";

const execFile = promisify(execFileCallback);

export interface DaimonDockerGuardInvocation {
  args: string[];
  command: string;
  cwd: string;
  dockerContext?: string | null;
  dockerHost?: string | null;
  opaqueDaimonCredentials?: boolean;
}

const parseDockerContextHost = (stdout: string): string | null => {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return trimmed;
  }
};

const resolveDockerContextHost = async (
  invocation: DaimonDockerGuardInvocation,
  context: string
): Promise<string | null> => {
  const { stdout } = await execFile(invocation.command, [
    "context", "inspect", context, "--format", "{{json .Endpoints.docker.Host}}"
  ], { cwd: invocation.cwd, timeout: 10_000 });
  return parseDockerContextHost(stdout);
};

const resolveActiveDockerContext = async (invocation: DaimonDockerGuardInvocation): Promise<string> => {
  const { stdout } = await execFile(invocation.command, ["context", "show"], {
    cwd: invocation.cwd,
    timeout: 10_000
  });
  const context = stdout.trim();
  if (!context || /\s/u.test(context)) {
    throw new SpawnfileError(
      "validation_error",
      "Unable to attest the active Docker context for opaque Daimon credentials"
    );
  }
  return context;
};

const resolveDockerDaemonEndpoint = async (
  invocation: DaimonDockerGuardInvocation
): Promise<string | null> => {
  if (invocation.dockerContext) return resolveDockerContextHost(invocation, invocation.dockerContext);
  if (invocation.dockerHost) return invocation.dockerHost;
  const ambientContext = process.env.DOCKER_CONTEXT?.trim();
  if (ambientContext) return resolveDockerContextHost(invocation, ambientContext);
  const ambientHost = process.env.DOCKER_HOST?.trim();
  if (ambientHost) return ambientHost;
  return resolveDockerContextHost(invocation, await resolveActiveDockerContext(invocation));
};

const isLocalDockerEndpoint = (host: string): boolean => {
  if (host.startsWith("/")) return true;
  if (host.startsWith("unix://")) {
    try {
      const endpoint = new URL(host);
      return endpoint.host === "" && endpoint.pathname.startsWith("/");
    } catch {
      return false;
    }
  }
  return host.startsWith("npipe:////./pipe/") || host.startsWith("npipe://./pipe/");
};

const explicitLocalEndpoint = (endpoint: string): string =>
  endpoint.startsWith("/") ? `unix://${endpoint}` : endpoint;

const withPinnedDockerEndpoint = <T extends DaimonDockerGuardInvocation>(
  invocation: T,
  endpoint: string
): T => {
  const run = invocation.args.indexOf("run");
  if (run < 0) {
    throw new SpawnfileError(
      "validation_error",
      "Unable to pin Docker daemon endpoint for opaque Daimon credentials"
    );
  }
  return {
    ...invocation,
    args: ["--host", endpoint, ...invocation.args.slice(run)],
    dockerContext: null,
    dockerHost: endpoint
  } as T;
};

/**
 * Resolves a possibly mutable Docker context once, validates that endpoint,
 * then makes every remaining Docker operation use the immutable endpoint.
 */
export const pinOpaqueDaimonDockerEndpoint = async <T extends DaimonDockerGuardInvocation>(
  invocation: T
): Promise<T> => {
  if (!invocation.opaqueDaimonCredentials) return invocation;
  let resolved: string | null;
  try {
    resolved = await resolveDockerDaemonEndpoint(invocation);
  } catch (error) {
    if (error instanceof SpawnfileError) throw error;
    throw new SpawnfileError(
      "validation_error",
      "Unable to attest the Docker daemon locality for opaque Daimon credentials"
    );
  }
  if (!resolved || !isLocalDockerEndpoint(resolved)) {
    throw new SpawnfileError(
      "validation_error",
      "Opaque Daimon credentials require a local Docker daemon; remote and SSH daemons are unsupported"
    );
  }
  return withPinnedDockerEndpoint(invocation, explicitLocalEndpoint(resolved));
};

export const assertOpaqueDaimonCredentialsUseLocalDaemon = async (
  invocation: DaimonDockerGuardInvocation
): Promise<void> => {
  await pinOpaqueDaimonDockerEndpoint(invocation);
};

export const assertOpaqueDaimonCredentialsHaveNoUserNamespace = async (
  invocation: DaimonDockerGuardInvocation
): Promise<void> => {
  if (!invocation.opaqueDaimonCredentials) return;
  if (invocation.dockerContext || !invocation.dockerHost) {
    throw new SpawnfileError(
      "validation_error",
      "Opaque Daimon credentials require a pinned Docker daemon endpoint before Docker info"
    );
  }
  const args = [
    "--host", invocation.dockerHost,
    "info", "--format", "{{json .SecurityOptions}}"
  ];
  let securityOptions: unknown;
  try {
    const { stdout } = await execFile(invocation.command, args, {
      cwd: invocation.cwd,
      timeout: 10_000
    });
    securityOptions = JSON.parse(stdout.trim());
  } catch {
    throw new SpawnfileError(
      "validation_error",
      "Unable to verify that the Docker daemon has no user namespace remapping for opaque Daimon credentials"
    );
  }
  if (!Array.isArray(securityOptions) || securityOptions.some((value) =>
    typeof value !== "string" || /userns|rootless/iu.test(value)
  )) {
    throw new SpawnfileError(
      "validation_error",
      "Opaque Daimon credentials require a Docker daemon without user namespace remapping"
    );
  }
};
