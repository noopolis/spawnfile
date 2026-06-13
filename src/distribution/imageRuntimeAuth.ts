import path from "node:path";

import type { ResolvedAuthProfile } from "../auth/index.js";
import { fileExists } from "../filesystem/index.js";
import { getRuntimeAdapter } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import type { DistributionReport } from "./types.js";

export interface ImageRuntimeAuthInput {
  authProfile: ResolvedAuthProfile;
  report: DistributionReport;
  tempRoot: string;
}

export interface ImageRuntimeAuthResult {
  coveredModelSecrets: Set<string>;
  mountArgs: string[];
}

const importMountTargetName = (kind: "claude-code" | "codex"): string =>
  kind === "claude-code" ? ".claude" : ".codex";

/**
 * Builds the credential mounts for a sourceless image deployment that uses
 * import-based model auth. The OAuth-mode config is already baked into the
 * image, so this only mounts the consumer's credential tokens (per-adapter) and
 * their raw import directories into each runtime home — the same material a
 * project deployment provides, without needing the project source.
 */
export const prepareImageRuntimeAuthMounts = async (
  input: ImageRuntimeAuthInput
): Promise<ImageRuntimeAuthResult> => {
  const coveredModelSecrets = new Set<string>();
  const mountArgs: string[] = [];
  const runtimeHomes = new Set<string>();

  for (const instance of input.report.runtime_instances) {
    if (instance.home_path) {
      runtimeHomes.add(instance.home_path);
    }
    const adapter = getRuntimeAdapter(instance.runtime);
    if (!adapter.prepareRuntimeAuth) {
      continue;
    }
    const prepared = await adapter.prepareRuntimeAuth({
      authProfile: input.authProfile,
      env: {},
      instance: {
        config_path: instance.config_path,
        home_path: instance.home_path,
        id: instance.id,
        model_auth_methods: instance.model_auth_methods,
        model_secrets_required: instance.model_secrets_required,
        runtime: instance.runtime
      },
      outputDirectory: "",
      tempRoot: input.tempRoot
    });
    for (const secret of prepared.coveredModelSecrets) {
      coveredModelSecrets.add(secret);
    }
    mountArgs.push(...prepared.mountArgs);
  }

  // Mount the raw credential import directories into each runtime home so the
  // runtime's OAuth client can read them (e.g. ~/.claude, ~/.codex).
  for (const kind of ["claude-code", "codex"] as const) {
    const entry = input.authProfile.imports[kind];
    if (!entry) {
      continue;
    }
    if (!(await fileExists(entry.path))) {
      throw new SpawnfileError(
        "validation_error",
        `Imported auth path for ${kind} does not exist: ${entry.path}`
      );
    }
    for (const home of runtimeHomes) {
      mountArgs.push("-v", `${entry.path}:${path.posix.join(home, importMountTargetName(kind))}`);
    }
  }

  return { coveredModelSecrets, mountArgs };
};
