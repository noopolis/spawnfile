import path from "node:path";

import { readUtf8File } from "../filesystem/index.js";
import type { ContainerRuntimeInstanceReport } from "../report/index.js";
import { SpawnfileError } from "../shared/index.js";

import type { CompileProjectResult } from "./compileProject.js";

export const DAIMON_CODEX_NATIVE_SANDBOX_DOCKER_SECURITY_OPTS = [
  "--security-opt=seccomp=unconfined",
  "--security-opt=apparmor=unconfined"
] as const;

const DAIMON_CONFIG_VERSIONS = [
  "noopolis.daimon.organization-runtime.v1",
  "noopolis.daimon.organization-runtime.v2"
] as const;

const DAIMON_CODEX_STRICT_SANDBOX = {
  mode: "workspace-write",
  networkAccess: false,
  webSearch: "disabled"
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const assertContainedPath = (root: string, candidate: string): string => {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SpawnfileError(
      "validation_error",
      "Daimon generated config path escapes the compiled container rootfs"
    );
  }
  return normalizedCandidate;
};

const configPathInOutput = (
  outputDirectory: string,
  instance: ContainerRuntimeInstanceReport
): string => {
  if (!instance.config_path.startsWith("/")) {
    throw new SpawnfileError(
      "validation_error",
      "Daimon runtime instance has a non-absolute generated config path"
    );
  }
  const rootfs = path.join(outputDirectory, "container", "rootfs");
  return assertContainedPath(rootfs, path.join(rootfs, `.${instance.config_path}`));
};

const hasExactCodexStrictSandbox = (engine: Record<string, unknown>): boolean => {
  const sandbox = engine.codexSandbox;
  if (sandbox === undefined) return false;
  if (!isRecord(sandbox)) {
    throw new SpawnfileError(
      "validation_error",
      "Daimon Codex sandbox policy has an invalid shape"
    );
  }
  const expected = DAIMON_CODEX_STRICT_SANDBOX as Record<string, unknown>;
  const keys = Object.keys(sandbox).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index] || sandbox[key] !== expected[key])
  ) {
    throw new SpawnfileError(
      "validation_error",
      "Daimon Codex sandbox policy is not the supported strict workspace-no-network policy"
    );
  }
  return true;
};

const configRequiresCodexNativeSandboxDockerInterop = (source: string): boolean => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new SpawnfileError(
      "validation_error",
      "Daimon generated organization config is not JSON"
    );
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.agents)) {
    throw new SpawnfileError(
      "validation_error",
      "Daimon generated organization config has an invalid shape"
    );
  }
  if (!(DAIMON_CONFIG_VERSIONS as readonly unknown[]).includes(parsed.version)) {
    throw new SpawnfileError(
      "validation_error",
      "Daimon generated organization config is not a supported v1/v2 contract"
    );
  }
  let requiresInterop = false;
  for (const agent of parsed.agents) {
    if (!isRecord(agent) || !isRecord(agent.engine)) {
      throw new SpawnfileError(
        "validation_error",
        "Daimon generated organization config has an invalid agent engine"
      );
    }
    const kind = agent.engine.kind;
    if (kind !== "agy" && kind !== "codex" && kind !== "grok") {
      throw new SpawnfileError(
        "validation_error",
        "Daimon generated organization config has an unsupported agent engine"
      );
    }
    if (kind === "codex" && hasExactCodexStrictSandbox(agent.engine)) {
      requiresInterop = true;
    }
  }
  return requiresInterop;
};

export const resolveDaimonCodexNativeSandboxDockerSecurityOptions = async (
  compileResult: CompileProjectResult
): Promise<string[]> => {
  const instances = compileResult.report.container?.runtime_instances
    .filter((instance) => instance.runtime === "daimon") ?? [];
  let requiresInterop = false;
  for (const instance of instances) {
    let source: string;
    try {
      source = await readUtf8File(configPathInOutput(compileResult.outputDirectory, instance));
    } catch (error) {
      if (error instanceof SpawnfileError) throw error;
      throw new SpawnfileError(
        "validation_error",
        "Could not read Daimon's generated organization config before Docker launch"
      );
    }
    if (configRequiresCodexNativeSandboxDockerInterop(source)) {
      requiresInterop = true;
    }
  }
  return requiresInterop ? [...DAIMON_CODEX_NATIVE_SANDBOX_DOCKER_SECURITY_OPTS] : [];
};
