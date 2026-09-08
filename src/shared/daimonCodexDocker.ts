import { SpawnfileError } from "./errors.js";

export const DAIMON_DOCKER_RUNTIME_SECURITY_ARGS = [
  "--cap-drop=ALL",
  "--cap-add=CHOWN",
  "--cap-add=SETUID",
  "--cap-add=SETGID",
  "--cap-add=DAC_READ_SEARCH",
  // Lets the broker launcher drop its bounding set to 00000000000000c1; without SETPCAP, setpriv --bounding-set silently no-ops.
  "--cap-add=SETPCAP",
  // The entrypoint supervises children dropped to uid 2100/2200+; without CAP_KILL, root cannot even kill -0 them, so a live child reads as dead.
  "--cap-add=KILL",
  "--security-opt=no-new-privileges:true"
] as const;

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

export const configRequiresCodexNativeSandboxDockerInterop = (source: string): boolean => {
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

export const codexNativeSandboxDockerSecurityArgsForConfigs = (sources: string[]): string[] => {
  let requiresInterop = false;
  for (const source of sources) {
    if (configRequiresCodexNativeSandboxDockerInterop(source)) {
      requiresInterop = true;
    }
  }
  return requiresInterop ? [...DAIMON_CODEX_NATIVE_SANDBOX_DOCKER_SECURITY_OPTS] : [];
};
