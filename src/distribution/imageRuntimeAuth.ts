import type { ResolvedAuthProfile } from "../auth/index.js";
import { getRuntimeAdapter, resolveImageCredentialUid, type ImageCredentialUidOptions } from "../runtime/index.js";
import { prepareRuntimeHomeImports } from "../runtime/runtimeHomeImports.js";
import { createLoginVolumeReservation } from "../runtime/nativeLogin.js";
import { adapterManagedAuthMethods, runtimeHost } from "../runtime/hostSelection.js";
import type { RuntimePreparedImageLaunch } from "../runtime/hostTypes.js";

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
  const importedAuth = await prepareRuntimeHomeImports(input.report.runtime_instances, input.authProfile);
  const reserveLoginVolume = createLoginVolumeReservation();

  for (const instance of input.report.runtime_instances) {
    const image = input.runtimePreparations?.get(instance.runtime);
    const host = runtimeHost(instance.runtime);
    const prepareAuth = image?.prepareAuth?.bind(image) ?? host?.prepareImageAuth?.bind(host);
    if (prepareAuth) {
      mountArgs.push(...await prepareAuth(instance, {
        authProfile: input.authProfile,
        reserveLoginVolume,
        containerCredentialUid: resolveImageCredentialUid(instance.runtime, credentialOptions),
        sourceEnvironment: input.sourceEnvironment ?? process.env,
        tempRoot: input.tempRoot
      }));
      continue;
    }
    if (!input.authProfile && !Object.values(instance.model_auth_methods).some(method => adapterManagedAuthMethods(instance.runtime)?.includes(method))) continue;
    const adapter = getRuntimeAdapter(instance.runtime);
    if (!adapter.prepareRuntimeAuth) {
      continue;
    }
    const prepared = await adapter.prepareRuntimeAuth({
      authProfile: input.authProfile,
      reserveLoginVolume,
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

  return { coveredModelSecrets, mountArgs: [...mountArgs, ...importedAuth.mountArgs] };
};
