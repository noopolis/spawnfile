import { SpawnfileError } from "../shared/index.js";

import { NOOPOLIS_RUN_ID_ENV, resolveNoopolisRunId } from "./common.js";
import type { RuntimeContainerPackageOverrides } from "./containerPackageOverrides.js";
import { createDaimonInstallRecipe } from "./daimon/install.js";
import { resolveRuntimeInstallSelection } from "./install.js";
import { createOpenClawInstallRecipe } from "./openclaw/install.js";
import { createPicoClawInstallRecipe } from "./picoclaw/install.js";

export const RUNTIME_INSTALL_ROOT = "/opt/spawnfile/runtime-installs";

export interface RuntimeInstallRecipe {
  baseImage?: string;
  commands: string[];
  copyCommands: string[];
  /**
   * Container environment variables this recipe's container must be
   * started with. Always includes NOOPOLIS_RUN_ID (see
   * src/runtime/common.ts) when a run id is available, so every authority
   * container stamps causal events with the same run_id — never a value
   * read from model output.
   */
  env: Record<string, string>;
  runtimeName: string;
  runtimeRoot: string;
}

/**
 * Builds the shared container env assembly injected into every generated
 * runtime install recipe. Currently just NOOPOLIS_RUN_ID, sourced from the
 * host/compile process environment; omitted entirely when unset rather
 * than stamping an empty value.
 */
export const createRuntimeContainerEnv = (
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> => {
  const runId = resolveNoopolisRunId(env);
  return runId ? { [NOOPOLIS_RUN_ID_ENV]: runId } : {};
};

const assertArtifactInstallSelection = (
  runtimeName: string,
  selection: Awaited<ReturnType<typeof resolveRuntimeInstallSelection>>
): void => {
  if (selection.kind !== "source_repo") {
    return;
  }

  throw new SpawnfileError(
    "runtime_error",
    `Runtime ${runtimeName} must use a compiled artifact install for generated containers`
  );
};

export interface RuntimeInstallRecipeOptions {
  /**
   * Compile-time-only local overrides for this runtime's install npm
   * packages (see src/runtime/containerPackageOverrides.ts and
   * src/compiler/containerPackageOverrides.ts). Never set during a
   * standard compile; only opt-in local/E2E harnesses populate this, and
   * only for the exact package names they override — every other package
   * in the recipe keeps its pinned registry `name@version` spec.
   */
  packageOverrides?: RuntimeContainerPackageOverrides;
}

export const createRuntimeInstallRecipe = async (
  runtimeName: string,
  _options: RuntimeInstallRecipeOptions = {}
): Promise<RuntimeInstallRecipe> => {
  const selection = await resolveRuntimeInstallSelection(runtimeName);
  assertArtifactInstallSelection(runtimeName, selection);

  const installRoot = `${RUNTIME_INSTALL_ROOT}/${runtimeName}`;
  const containerEnv = createRuntimeContainerEnv();

  const input = { containerEnv, installRoot, runtimeName, selection };
  switch (runtimeName) {
    case "openclaw":
      return createOpenClawInstallRecipe(input);
    case "picoclaw":
      return createPicoClawInstallRecipe(input);
    case "daimon":
      return createDaimonInstallRecipe(input);
    /* c8 ignore next 5 -- compileable runtimes are exhaustively covered above */
    default:
      throw new SpawnfileError(
        "runtime_error",
        `Runtime ${runtimeName} has no container install recipe`
      );
  }
};
