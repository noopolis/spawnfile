import { Option } from "commander";

import { SpawnfileError } from "../shared/index.js";

/**
 * Node reads `--env-file` from the WHOLE argv, script arguments included
 * (verified on 22.23 and 24.21): `node dist/cli/index.js up --env-file x`
 * dies with `node: x: not found` (exit 9) before Spawnfile runs when x is
 * missing or unreadable, and a `NODE_OPTIONS=` line in x is applied to the
 * Spawnfile process itself. `--runtime-env-file` is the spelling Node does not
 * claim; `--env-file` stays as a hidden alias for existing callers.
 */
export const RUNTIME_ENV_FILE_FLAG = "--runtime-env-file";

export interface EnvFileOptions {
  envFile?: string;
  runtimeEnvFile?: string;
}

export const runtimeEnvFileOption = (description: string, valueName = "file"): Option =>
  new Option(`${RUNTIME_ENV_FILE_FLAG} <${valueName}>`, description);

export const envFileAliasOption = (valueName = "file"): Option =>
  new Option(`--env-file <${valueName}>`, `Alias of ${RUNTIME_ENV_FILE_FLAG}`).hideHelp();

/** One env file: either spelling, never two different files. */
export const resolveEnvFileOption = (options: EnvFileOptions): string | undefined => {
  if (options.runtimeEnvFile !== undefined && options.envFile !== undefined && options.runtimeEnvFile !== options.envFile) {
    throw new SpawnfileError("validation_error", `${RUNTIME_ENV_FILE_FLAG} and --env-file name different files; pass one`);
  }
  return options.runtimeEnvFile ?? options.envFile;
};
