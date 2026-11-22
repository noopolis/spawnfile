import path from "node:path";

import type { RuntimeHomeAuthMethod } from "../runtime/types.js";
import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import { escapeMountInfoPath } from "./containerBackedMountRender.js";
import { CLI_CREDENTIAL_SECRET_NAME, modelAuthMethodNeedsCliCredential } from "./modelEnv.js";

export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

/** The same per-instance process environment applies to service startup and native training turns. */
export function runtimeInstanceEnvironment(
  { instancePaths: { homePath, configPath }, meta, modelAuthMethods, port }:
    Pick<RuntimeTargetPlan, "instancePaths" | "meta" | "modelAuthMethods" | "port">
): [string, string][] {
  const values: [string, string][] = [];
  if (homePath) {
    values.push(["HOME", homePath]);
    if (Object.values(modelAuthMethods).some(method => modelAuthMethodNeedsCliCredential(method, meta.adapterManagedAuthMethods))) {
      values.push(["CODEX_HOME", path.posix.join(homePath, ".codex")]);
    }
    if (meta.homeEnv) values.push([meta.homeEnv, homePath]);
  }
  if (meta.configPathEnv) values.push([meta.configPathEnv, configPath]);
  if (meta.portEnv && port) values.push([meta.portEnv, String(port)]);
  return values.concat(Object.entries(meta.staticEnv ?? {}).sort(([left], [right]) => left.localeCompare(right)));
}

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
  const mountCheck = (home: string, directory: string, file: string): string => {
    const target = path.posix.join(home, directory);
    return `has_cli_import ${shellQuote(escapeMountInfoPath(target))} ${shellQuote(path.posix.join(target, file))}`;
  };
  const blocks = runtimePlans.flatMap(({ instancePaths: { homePath }, modelAuthMethods, meta }) => {
    const methods = [...new Set(Object.values(modelAuthMethods).filter((method): method is RuntimeHomeAuthMethod =>
      modelAuthMethodNeedsCliCredential(method, meta.adapterManagedAuthMethods)))];
    if (!homePath || methods.length === 0) return [];

    const codexHome = path.posix.join(homePath, ".codex");
    const codexAuth = shellQuote(path.posix.join(codexHome, "auth.json"));
    const codexImport = mountCheck(homePath, ".codex", "auth.json");
    const claudeImport = mountCheck(homePath, ".claude", ".credentials.json");
    const selected = methods.map(method => meta.rawHomeAuthImports?.includes(method)
      ? (method === "codex" ? codexImport : claudeImport) : "false");
    return [
      `if ! { ${selected.join(" && ")}; }; then`,
      `  require_env ${shellQuote(CLI_CREDENTIAL_SECRET_NAME)}`,
      `  if ! ${codexImport}; then`,
      `    mkdir -m 700 -p ${shellQuote(codexHome)}`,
      `    printf %s "\${${CLI_CREDENTIAL_SECRET_NAME}}" > ${codexAuth}`,
      `    chmod 600 ${codexAuth}`,
      "  fi",
      "fi"
    ];
  });
  if (blocks.length === 0) return [];
  return [
    "has_cli_import() {",
    "  local mount_point",
    "  [ -r /proc/self/mountinfo ] || return 1",
    "  while read -r _ _ _ _ mount_point _; do",
    '    if [ "$mount_point" = "$1" ]; then',
    '      require_file "$2"',
    "      return 0",
    "    fi",
    "  done < /proc/self/mountinfo",
    "  return 1",
    "}",
    "# An explicit env credential remains in Docker Config.Env even after unset.",
    ...blocks,
    `unset ${CLI_CREDENTIAL_SECRET_NAME}`,
    ""
  ];
};
