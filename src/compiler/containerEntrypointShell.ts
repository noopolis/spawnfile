import path from "node:path";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import { CLI_CREDENTIAL_SECRET_NAME, modelAuthMethodNeedsCliCredential } from "./modelEnv.js";

export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

export const createRecipeEnvAssignments = (
  recipeEnv: Record<string, string> | undefined
): string[] =>
  Object.entries(recipeEnv ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${shellQuote(value)}`);

export const mergeRecipeEnv = (runtimePlans: RuntimeTargetPlan[]): Record<string, string> =>
  runtimePlans.reduce<Record<string, string>>(
    (merged, plan) => ({ ...merged, ...(plan.recipeEnv ?? {}) }),
    {}
  );

export const createCliCredentialMaterialization = (
  runtimePlans: RuntimeTargetPlan[]
): string[] => {
  const homePaths = [...new Set(runtimePlans
    .filter((plan) => plan.instancePaths.homePath &&
      Object.values(plan.modelAuthMethods).some(modelAuthMethodNeedsCliCredential))
    .map((plan) => path.posix.join(plan.instancePaths.homePath!, ".codex")))];
  if (homePaths.length === 0) return [];

  return [
    "# SPAWNFILE_CLI_AUTH_JSON persists in Config.Env for the container's lifetime.",
    "# unset removes it from runtime processes' environments but cannot remove it from the container definition.",
    "# Anyone with docker access on the host can read it, and every docker exec inherits it.",
    "# This is accepted because the target host is single-user and the container is destroyed each run;",
    "# a non-env delivery route is the fix if this ever runs anywhere shared.",
    ...homePaths.flatMap((homePath) => [
      `mkdir -m 700 -p ${shellQuote(homePath)}`,
      `printf %s "\${${CLI_CREDENTIAL_SECRET_NAME}}" > ${shellQuote(path.posix.join(homePath, "auth.json"))}`,
      `chmod 600 ${shellQuote(path.posix.join(homePath, "auth.json"))}`
    ]),
    `unset ${CLI_CREDENTIAL_SECRET_NAME}`,
    ""
  ];
};
