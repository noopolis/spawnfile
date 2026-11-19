import type { ResolvedAuthProfile } from "../auth/index.js";
import {
  loadImportedClaudeCodeCredential,
  loadImportedCodexCredential
} from "../auth/index.js";
import { fileExists } from "../filesystem/index.js";
import { getRuntimeAdapter, resolveImageCredentialUid, type ImageCredentialUidOptions } from "../runtime/index.js";
import { resolveRuntimeHomeImports } from "../runtime/runtimeHomeImports.js";
import { runtimeHost } from "../runtime/hostSelection.js";
import type { RuntimePreparedImageLaunch } from "../runtime/hostTypes.js";
import { SpawnfileError } from "../shared/index.js";

import type { DistributionReport } from "./types.js";

export interface ImageRuntimeAuthInput extends ImageCredentialUidOptions {
  authProfile: ResolvedAuthProfile | null;
  runtimePreparations?: ReadonlyMap<string, RuntimePreparedImageLaunch>;
  report: DistributionReport;
  sourceEnvironment?: Record<string, string | undefined>;
  tempRoot: string;
}

export interface ImageRuntimeAuthResult {
  coveredModelSecrets: Set<string>;
  mountArgs: string[];
}

/** Prepares adapter credentials and declared raw auth imports for a prebuilt image. */
export const prepareImageRuntimeAuthMounts = async (
  input: ImageRuntimeAuthInput,
  credentialOptions: ImageCredentialUidOptions = input
): Promise<ImageRuntimeAuthResult> => {
  const coveredModelSecrets = new Set<string>();
  const mountArgs: string[] = [];
  const imports = resolveRuntimeHomeImports(input.report.runtime_instances, input.authProfile);

  for (const instance of input.report.runtime_instances) {
    const image = input.runtimePreparations?.get(instance.runtime);
    const host = runtimeHost(instance.runtime);
    const prepareAuth = image?.prepareAuth?.bind(image) ?? host?.prepareImageAuth?.bind(host);
    if (prepareAuth) {
      mountArgs.push(...await prepareAuth(instance, {
        authProfile: input.authProfile,
        containerCredentialUid: resolveImageCredentialUid(instance.runtime, credentialOptions),
        sourceEnvironment: input.sourceEnvironment ?? process.env,
        tempRoot: input.tempRoot
      }));
      continue;
    }
    if (!input.authProfile) continue;
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

  for (const { method, source, targets } of imports) {
    if (!(await fileExists(source))) {
      throw new SpawnfileError("validation_error", `Imported auth path for ${method} does not exist: ${source}`);
    }
    const credential = method === "claude-code"
      ? await loadImportedClaudeCodeCredential(source)
      : await loadImportedCodexCredential(source);
    if (!credential) {
      throw new SpawnfileError(
        "validation_error",
        `Imported ${method} auth at ${source} has no usable credential. ` +
          `Re-run the ${method} login (or re-import) before deploying this image.`
      );
    }
    for (const target of targets) mountArgs.push("-v", `${source}:${target}`);
  }

  return { coveredModelSecrets, mountArgs };
};
