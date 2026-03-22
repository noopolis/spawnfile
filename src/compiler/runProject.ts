import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

import { requireAuthProfile, type ResolvedAuthProfile } from "../auth/index.js";
import { ensureDirectory, fileExists, removeDirectory, writeUtf8File } from "../filesystem/index.js";
import type { ContainerReport } from "../report/index.js";
import { SpawnfileError } from "../shared/index.js";

import {
  compileProject,
  type CompileProjectOptions,
  type CompileProjectResult
} from "./compileProject.js";
import { createDefaultImageTag } from "./buildProject.js";
import { slugify } from "./helpers.js";
import {
  assertDeclaredModelAuthSatisfied,
  prepareRuntimeAuthMounts
} from "./runProjectAuth.js";

export interface DockerRunInvocation {
  args: string[];
  command: string;
  containerName: string | null;
  cwd: string;
  detach: boolean;
  envFilePath: string;
  imageTag: string;
  supportDirectory: string;
}

export type DockerRunRunner = (invocation: DockerRunInvocation) => Promise<void>;

export interface RunProjectOptions extends CompileProjectOptions {
  authProfile?: string;
  containerName?: string;
  detach?: boolean;
  dockerCommand?: string;
  imageTag?: string;
  runRunner?: DockerRunRunner;
}

export interface RunProjectResult extends CompileProjectResult {
  authProfileName: string | null;
  containerName: string | null;
  imageTag: string;
}

const resolveImageTagRoot = (inputPath: string): string => {
  const resolvedPath = path.resolve(inputPath);
  return path.basename(resolvedPath).toLowerCase() === "spawnfile"
    ? path.dirname(resolvedPath)
    : resolvedPath;
};

const createDefaultContainerName = (imageTag: string): string => {
  const containerName = slugify(imageTag.replaceAll("/", "-").replaceAll(":", "-"));
  return containerName || "spawnfile-run";
};

const getImportMountTargetName = (kind: keyof ResolvedAuthProfile["imports"]): string =>
  kind === "claude-code" ? ".claude" : ".codex";

const createGeneratedRuntimeSecret = (secretName: string): string | null => {
  if (secretName === "OPENCLAW_GATEWAY_TOKEN") {
    return randomBytes(24).toString("hex");
  }

  return null;
};

const hasEnvValue = (env: Record<string, string>, name: string): boolean =>
  typeof env[name] === "string" && env[name]!.length > 0;

const collectMissingRequiredSecrets = (
  containerReport: ContainerReport,
  env: Record<string, string>,
  coveredModelSecrets: Set<string>
): string[] => {
  const missing = new Set<string>();

  for (const secretName of containerReport.secrets_required) {
    if (hasEnvValue(env, secretName)) {
      continue;
    }

    if (!containerReport.model_secrets_required.includes(secretName)) {
      missing.add(secretName);
      continue;
    }

    const requiredInstances = (containerReport.runtime_instances ?? []).filter((instance) =>
      instance.model_secrets_required.includes(secretName)
    );
    const isCoveredEverywhere =
      requiredInstances.length > 0 &&
      requiredInstances.every((instance) => coveredModelSecrets.has(`${instance.id}:${secretName}`));

    if (!isCoveredEverywhere) {
      missing.add(secretName);
    }
  }

  return [...missing].sort();
};

const resolveRunEnvironment = (
  containerReport: ContainerReport,
  authProfile: ResolvedAuthProfile | null
): Record<string, string> => {
  const env: Record<string, string> = {
    ...(authProfile?.env ?? {})
  };

  for (const name of new Set([...Object.keys(env), ...containerReport.secrets_required])) {
    const processValue = process.env[name];
    if (typeof processValue === "string" && processValue.length > 0) {
      env[name] = processValue;
    }
  }

  for (const name of containerReport.runtime_secrets_required) {
    if (hasEnvValue(env, name)) {
      continue;
    }

    const generatedValue = createGeneratedRuntimeSecret(name);
    if (generatedValue) {
      env[name] = generatedValue;
    }
  }

  for (const [name, value] of Object.entries(env)) {
    if (value.includes("\n")) {
      throw new SpawnfileError(
        "validation_error",
        `Env value for ${name} contains a newline and cannot be written to a Docker env file`
      );
    }
  }

  return env;
};

const assertRunEnvironmentSatisfied = (
  containerReport: ContainerReport,
  env: Record<string, string>,
  coveredModelSecrets: Set<string>
): void => {
  const missing = collectMissingRequiredSecrets(containerReport, env, coveredModelSecrets);
  if (missing.length > 0) {
    throw new SpawnfileError(
      "validation_error",
      `Missing required runtime env: ${missing.sort().join(", ")}`
    );
  }
};

const renderDockerEnvFile = (env: Record<string, string>): string =>
  `${Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;

const resolveAuthMountArgs = async (
  containerReport: ContainerReport,
  authProfile: ResolvedAuthProfile | null
): Promise<string[]> => {
  if (!authProfile || containerReport.runtime_homes.length === 0) {
    return [];
  }

  const args: string[] = [];

  for (const [kind, entry] of Object.entries(authProfile.imports) as Array<
    [
      keyof ResolvedAuthProfile["imports"],
      ResolvedAuthProfile["imports"][keyof ResolvedAuthProfile["imports"]]
    ]
  >) {
    if (!entry) {
      continue;
    }

    if (!(await fileExists(entry.path))) {
      throw new SpawnfileError(
        "validation_error",
        `Imported auth path for ${kind} does not exist: ${entry.path}`
      );
    }

    for (const runtimeHome of containerReport.runtime_homes) {
      args.push("-v", `${entry.path}:${path.posix.join(runtimeHome, getImportMountTargetName(kind))}`);
    }
  }

  return args;
};

export const createDockerRunInvocation = async (
  compileResult: CompileProjectResult,
  imageTag: string,
  options: {
    authProfile?: ResolvedAuthProfile | null;
    containerName?: string;
    detach?: boolean;
    dockerCommand?: string;
  } = {}
): Promise<DockerRunInvocation> => {
  const containerReport = compileResult.report.container;
  if (!containerReport) {
    throw new SpawnfileError(
      "runtime_error",
      "Compile output did not include container metadata"
    );
  }

  const supportDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-run-"));
  const envFilePath = path.join(supportDirectory, "run.env");

  try {
    assertDeclaredModelAuthSatisfied(containerReport, options.authProfile ?? null);
    const env = resolveRunEnvironment(containerReport, options.authProfile ?? null);
    const preparedRuntimeAuth = await prepareRuntimeAuthMounts(
      compileResult.outputDirectory,
      containerReport,
      options.authProfile ?? null,
      env,
      supportDirectory
    );
    assertRunEnvironmentSatisfied(containerReport, env, preparedRuntimeAuth.coveredModelSecrets);

    await ensureDirectory(supportDirectory);
    await writeUtf8File(envFilePath, renderDockerEnvFile(env));

    const containerName = options.containerName ?? createDefaultContainerName(imageTag);
    const args = ["run"];

    if (options.detach) {
      args.push("-d");
    } else {
      args.push("--rm");
    }

    args.push("--name", containerName);

    for (const port of containerReport.ports) {
      args.push("-p", `${port}:${port}`);
    }

    args.push("--env-file", envFilePath);
    args.push(...(await resolveAuthMountArgs(containerReport, options.authProfile ?? null)));
    args.push(...preparedRuntimeAuth.mountArgs);
    args.push(imageTag);

    return {
      args,
      command: options.dockerCommand ?? "docker",
      containerName,
      cwd: compileResult.outputDirectory,
      detach: options.detach ?? false,
      envFilePath,
      imageTag,
      supportDirectory
    };
  } catch (error) {
    await removeDirectory(supportDirectory);
    throw error;
  }
};

export const runDockerContainer: DockerRunRunner = async (
  invocation: DockerRunInvocation
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: "inherit"
    });

    child.once("error", (error) => {
      reject(
        new SpawnfileError(
          "runtime_error",
          `Unable to start docker run for ${invocation.imageTag}: ${error.message}`
        )
      );
    });

    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new SpawnfileError(
          "runtime_error",
          signal
            ? `Docker run for ${invocation.imageTag} exited from signal ${signal}`
            : `Docker run for ${invocation.imageTag} failed with exit code ${code ?? "unknown"}`
        )
      );
    });
  });

export const runProject = async (
  inputPath: string,
  options: RunProjectOptions = {}
): Promise<RunProjectResult> => {
  const compileResult = await compileProject(inputPath, {
    clean: options.clean,
    outputDirectory: options.outputDirectory
  });
  const imageTag = options.imageTag ?? createDefaultImageTag(resolveImageTagRoot(inputPath));
  const authProfile = options.authProfile
    ? await requireAuthProfile(options.authProfile)
    : null;
  const invocation = await createDockerRunInvocation(compileResult, imageTag, {
    authProfile,
    containerName: options.containerName,
    detach: options.detach,
    dockerCommand: options.dockerCommand
  });

  try {
    await (options.runRunner ?? runDockerContainer)(invocation);
  } finally {
    if (!invocation.detach) {
      await removeDirectory(invocation.supportDirectory);
    }
  }

  return {
    ...compileResult,
    authProfileName: authProfile?.name ?? null,
    containerName: invocation.containerName,
    imageTag
  };
};
