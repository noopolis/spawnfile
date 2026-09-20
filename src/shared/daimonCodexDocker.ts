import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DAIMON_GROK_SECCOMP_PROFILE_BYTES,
  DAIMON_GROK_SECCOMP_PROFILE_FILE_NAME,
  DAIMON_GROK_SECCOMP_PROFILE_SHA256
} from "./daimonGrokSeccompProfile.js";
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

export interface DaimonEngineDockerInterop {
  /** A strict Codex agent needs seccomp and AppArmor fully unconfined for its own bubblewrap sandbox. */
  codex: boolean;
  /** A brokered Grok worker needs bubblewrap's namespace syscalls: the pinned seccomp profile plus AppArmor unconfined. */
  grok: boolean;
}

export const resolveDaimonEngineDockerInterop = (source: string): DaimonEngineDockerInterop => {
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
  const interop = { codex: false, grok: false };
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
    if (kind === "codex" && hasExactCodexStrictSandbox(agent.engine)) interop.codex = true;
    if (kind === "grok") interop.grok = true;
  }
  return interop;
};

export const configRequiresCodexNativeSandboxDockerInterop = (source: string): boolean =>
  resolveDaimonEngineDockerInterop(source).codex;

export const DAIMON_GROK_HOST_USERNS_PREREQUISITE =
  "kernel.apparmor_restrict_unprivileged_userns=0" as const;

/**
 * Writes the pinned Grok seccomp profile into `directory` (content-addressed,
 * verified after writing) and returns its absolute path. Docker reads a
 * `seccomp=<file>` option on the client at `docker run` and stores the profile
 * in the container config, so the file only has to exist for that call.
 */
export const materializeDaimonGrokSeccompProfile = async (directory: string): Promise<string> => {
  const target = path.resolve(directory, `${DAIMON_GROK_SECCOMP_PROFILE_SHA256.slice(0, 16)}-${DAIMON_GROK_SECCOMP_PROFILE_FILE_NAME}`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, DAIMON_GROK_SECCOMP_PROFILE_BYTES, { mode: 0o644 });
  const written = await readFile(target);
  if (createHash("sha256").update(written).digest("hex") !== DAIMON_GROK_SECCOMP_PROFILE_SHA256) {
    throw new SpawnfileError("runtime_error", "Pinned Grok seccomp profile did not materialize byte-for-byte");
  }
  return target;
};

/**
 * Docker security options for a Daimon container, by the engines its configs run.
 *
 * Codex's strict native sandbox needs seccomp and AppArmor fully unconfined, and
 * that superset also lets Grok's bubblewrap run, so it wins whenever a strict
 * Codex agent is present. Otherwise a Grok agent gets Docker's default seccomp
 * profile plus bubblewrap's seven namespace syscalls (pinned bytes) and AppArmor
 * unconfined — the narrowest combination under which Grok 1.0.34 starts. Grok
 * additionally needs the Docker host to allow unprivileged user namespaces
 * (`kernel.apparmor_restrict_unprivileged_userns=0`); the container entrypoint
 * checks that before the broker starts.
 */
export const daimonEngineDockerSecurityArgsForConfigs = (
  sources: string[],
  grokSeccompProfilePath: () => Promise<string>
): Promise<string[]> => {
  const interop = sources.map(resolveDaimonEngineDockerInterop);
  if (interop.some((entry) => entry.codex)) return Promise.resolve([...DAIMON_CODEX_NATIVE_SANDBOX_DOCKER_SECURITY_OPTS]);
  if (!interop.some((entry) => entry.grok)) return Promise.resolve([]);
  return grokSeccompProfilePath().then((profilePath) => {
    if (!path.isAbsolute(profilePath)) throw new SpawnfileError("runtime_error", "Grok seccomp profile path must be absolute");
    return [`--security-opt=seccomp=${profilePath}`, "--security-opt=apparmor=unconfined"];
  });
};

export const codexNativeSandboxDockerSecurityArgsForConfigs = (sources: string[]): string[] =>
  sources.some(configRequiresCodexNativeSandboxDockerInterop) ? [...DAIMON_CODEX_NATIVE_SANDBOX_DOCKER_SECURITY_OPTS] : [];
