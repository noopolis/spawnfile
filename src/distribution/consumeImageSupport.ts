import { randomBytes } from "node:crypto";

import { normalizeProjectLabelSlug } from "./projectName.js";
import type { ParsedImageReference } from "./imageRef.js";
import type { DistributionReport } from "./types.js";

const GENERATED_RUNTIME_SECRET_NAMES = new Set([
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_HOOKS_TOKEN"
]);

/** Derives a kebab-case deployment name from the image repository component. */
export const deriveDeploymentName = (ref: ParsedImageReference): string => {
  const base = ref.name.split("/").pop() ?? ref.name;
  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "deployment";
};

/** Per-deployment volume name so two deployments never share a store. */
export const deriveVolumeName = (deploymentName: string, mountId: string): string => {
  const safeMount = mountId.replace(/[^A-Za-z0-9_.-]+/g, "-");
  return `spawnfile_${deploymentName}_${safeMount}`;
};

export interface ResolveImageEnvironmentInput {
  authValues: Record<string, string>;
  envFileEnv?: Record<string, string>;
  report: DistributionReport;
}

/**
 * Builds the container environment for a sourceless deployment: auth-profile
 * and env-file values, process-env overrides for declared secrets, and
 * generated runtime tokens that the user must never supply.
 */
export const resolveImageEnvironment = (
  input: ResolveImageEnvironmentInput
): Record<string, string> => {
  const env: Record<string, string> = {
    ...input.authValues,
    ...(input.envFileEnv ?? {})
  };

  const declaredSecrets = new Set<string>();
  for (const category of ["model", "project", "runtime", "surface"] as const) {
    for (const entry of input.report.secrets[category]) {
      declaredSecrets.add(entry.name);
    }
  }

  for (const name of new Set([...Object.keys(env), ...declaredSecrets])) {
    const processValue = process.env[name];
    if (typeof processValue === "string" && processValue.length > 0) {
      env[name] = processValue;
    }
  }

  for (const category of ["runtime"] as const) {
    for (const entry of input.report.secrets[category]) {
      if (!entry.generated) {
        continue;
      }
      const hasValue = typeof env[entry.name] === "string" && env[entry.name]!.length > 0;
      if (!hasValue && GENERATED_RUNTIME_SECRET_NAMES.has(entry.name)) {
        env[entry.name] = randomBytes(24).toString("hex");
      }
    }
  }

  for (const [name, value] of Object.entries(env)) {
    if (value.includes("\n")) {
      delete env[name];
    }
  }

  return env;
};

export const renderEnvFileContent = (env: Record<string, string>): string =>
  Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n") + "\n";
