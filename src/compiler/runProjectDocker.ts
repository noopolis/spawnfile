import { execFile as execFileCallback, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { SpawnfileError } from "../shared/index.js";

const execFile = promisify(execFileCallback);

export interface DockerRunInvocation {
  args: string[];
  command: string;
  containerName: string | null;
  cwd: string;
  detach: boolean;
  deploymentName?: string | null;
  dockerContext?: string | null;
  dockerHost?: string | null;
  envFilePath: string;
  imageTag: string;
  supportDirectory: string;
}

export interface DockerRunResult {
  containerId?: string;
  imageId?: string;
}

export type DockerRunRunner = (invocation: DockerRunInvocation) => Promise<DockerRunResult | void>;

interface SshDockerContext {
  host: string;
  port?: string;
  target: string;
}

interface PreparedRunInvocation {
  cleanup(): Promise<void>;
  invocation: DockerRunInvocation;
}

const parseDockerContextHost = (stdout: string): string | null => {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return trimmed;
  }
};

const resolveSshDockerContext = async (
  invocation: DockerRunInvocation
): Promise<SshDockerContext | null> => {
  if (!invocation.dockerContext) {
    return null;
  }

  const { stdout } = await execFile(
    invocation.command,
    [
      "context",
      "inspect",
      invocation.dockerContext,
      "--format",
      "{{json .Endpoints.docker.Host}}"
    ],
    { cwd: invocation.cwd, timeout: 10_000 }
  );
  const host = parseDockerContextHost(stdout);
  if (!host?.startsWith("ssh://")) {
    return null;
  }

  const url = new URL(host);
  const user = decodeURIComponent(url.username);
  const targetHost = url.hostname;
  return {
    host,
    ...(url.port ? { port: url.port } : {}),
    target: user ? `${user}@${targetHost}` : targetHost
  };
};

const sshArgs = (context: SshDockerContext, command: string): string[] => [
  ...(context.port ? ["-p", context.port] : []),
  context.target,
  command
];

const scpArgs = (context: SshDockerContext, source: string, target: string): string[] => [
  ...(context.port ? ["-P", context.port] : []),
  "-r",
  source,
  `${context.target}:${target}`
];

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\"'\"'`)}'`;

const createRemoteDirectory = async (context: SshDockerContext): Promise<string> => {
  const { stdout } = await execFile("ssh", sshArgs(context, "mktemp -d /tmp/spawnfile-run-XXXXXX"), {
    timeout: 10_000
  });
  return stdout.trim();
};

const copyPathToRemote = async (
  context: SshDockerContext,
  sourcePath: string,
  remotePath: string
): Promise<void> => {
  await execFile("scp", scpArgs(context, sourcePath, remotePath), { timeout: 120_000 });
};

const removeRemoteDirectory = async (
  context: SshDockerContext,
  remoteDirectory: string
): Promise<void> => {
  await execFile("ssh", sshArgs(context, `rm -rf ${shellQuote(remoteDirectory)}`), {
    timeout: 10_000
  });
};

const splitVolumeSpec = (spec: string): { rest: string; source: string } | null => {
  const delimiter = spec.indexOf(":");
  if (delimiter <= 0) {
    return null;
  }
  return {
    rest: spec.slice(delimiter),
    source: spec.slice(0, delimiter)
  };
};

const collectBindMountSources = (args: string[]): string[] => {
  const sources = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-v" && args[index] !== "--volume") {
      continue;
    }
    const volume = args[index + 1];
    if (!volume) {
      continue;
    }
    const parsed = splitVolumeSpec(volume);
    if (parsed && path.isAbsolute(parsed.source)) {
      sources.add(parsed.source);
    }
    index += 1;
  }
  return [...sources].sort();
};

const rewriteBindMountSources = (
  args: string[],
  replacements: Map<string, string>
): string[] =>
  args.map((arg, index) => {
    const previous = args[index - 1];
    if (previous !== "-v" && previous !== "--volume") {
      return arg;
    }
    const parsed = splitVolumeSpec(arg);
    if (!parsed) {
      return arg;
    }
    const replacement = replacements.get(parsed.source);
    return replacement ? `${replacement}${parsed.rest}` : arg;
  });

const prepareRemoteBindMounts = async (
  invocation: DockerRunInvocation
): Promise<PreparedRunInvocation> => {
  const context = await resolveSshDockerContext(invocation);
  if (!context) {
    return { cleanup: async () => undefined, invocation };
  }

  const sources = collectBindMountSources(invocation.args);
  if (sources.length === 0) {
    return { cleanup: async () => undefined, invocation };
  }

  const remoteDirectory = await createRemoteDirectory(context);
  const replacements = new Map<string, string>();

  for (const [index, source] of sources.entries()) {
    const remotePath = `${remoteDirectory}/${index}-${path.basename(source) || "mount"}`;
    await copyPathToRemote(context, source, remotePath);
    replacements.set(source, remotePath);
  }

  return {
    cleanup: invocation.detach
      ? async () => undefined
      : async () => removeRemoteDirectory(context, remoteDirectory),
    invocation: {
      ...invocation,
      args: rewriteBindMountSources(invocation.args, replacements)
    }
  };
};

const inspectImageArgs = (
  invocation: DockerRunInvocation,
  containerId: string
): string[] => {
  const base = invocation.dockerContext
    ? ["--context", invocation.dockerContext, "inspect"]
    : invocation.dockerHost
      ? ["--host", invocation.dockerHost, "inspect"]
      : ["inspect"];
  return [...base, "--format", "{{.Image}}", containerId];
};

const inspectDetachedImageId = async (
  invocation: DockerRunInvocation,
  containerId: string
): Promise<string | undefined> => {
  try {
    const { stdout } = await execFile(invocation.command, inspectImageArgs(invocation, containerId), {
      cwd: invocation.cwd,
      timeout: 10_000
    });
    return stdout.trim() || undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError(
      "runtime_error",
      `Unable to inspect detached container ${containerId} image id: ${message}`
    );
  }
};

const runPreparedDockerContainer = (
  prepared: PreparedRunInvocation
): Promise<DockerRunResult | void> =>
  new Promise<DockerRunResult | void>((resolve, reject) => {
    let stdout = "";
    const child = spawn(prepared.invocation.command, prepared.invocation.args, {
      cwd: prepared.invocation.cwd,
      stdio: prepared.invocation.detach ? ["ignore", "pipe", "inherit"] : "inherit"
    });

    const settle = (finish: () => void): void => {
      prepared.cleanup().then(finish, reject);
    };
    const rejectAfterCleanup = (error: unknown): void => {
      prepared.cleanup().then(() => reject(error), reject);
    };

    if (prepared.invocation.detach && child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
    }

    child.once("error", (error) => {
      rejectAfterCleanup(
        new SpawnfileError(
          "runtime_error",
          `Unable to start docker run for ${prepared.invocation.imageTag}: ${error.message}`
        )
      );
    });

    child.once("exit", (code, signal) => {
      if (code === 0) {
        const containerId = stdout.trim().split(/\s+/)[0];
        if (!prepared.invocation.detach || !containerId) {
          settle(() => resolve(undefined));
          return;
        }
        inspectDetachedImageId(prepared.invocation, containerId)
          .then((imageId) => resolve({ containerId, ...(imageId ? { imageId } : {}) }))
          .catch(reject);
        return;
      }

      rejectAfterCleanup(
        new SpawnfileError(
          "runtime_error",
          signal
            ? `Docker run for ${prepared.invocation.imageTag} exited from signal ${signal}`
            : `Docker run for ${prepared.invocation.imageTag} failed with exit code ${code ?? "unknown"}`
        )
      );
    });
  });

export const runDockerContainer: DockerRunRunner = (
  invocation: DockerRunInvocation
): Promise<DockerRunResult | void> => {
  if (!invocation.dockerContext || collectBindMountSources(invocation.args).length === 0) {
    return runPreparedDockerContainer({
      cleanup: async () => undefined,
      invocation
    });
  }

  return prepareRemoteBindMounts(invocation).then(runPreparedDockerContainer);
};
