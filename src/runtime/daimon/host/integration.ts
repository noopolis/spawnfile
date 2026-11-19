import type { RuntimeHostIntegration } from "../../hostTypes.js";
import { DAIMON_CONTROL_TOKEN_ENV } from "../drain.js";
import { DAIMON_LOCAL_RUNTIME_IDENTITY_ENV, loadLocalDaimonRuntimeIdentity } from "../localDaimonAuthority.js";
import { daimonProfileRealmVolume } from "../subscriptionRealms.js";
import { DAIMON_DOCKER_RUNTIME_SECURITY_ARGS } from "./codexDocker.js";
import {
  assertOpaqueDaimonCredentialsHaveNoUserNamespace, pinOpaqueDaimonDockerEndpoint
} from "./dockerGuards.js";
import { resolveDaimonCodexNativeSandboxDockerSecurityOptions } from "./dockerRun.js";
import { daimonHostEntrypoint } from "./entrypoint.js";
import { createDaimonImageAuthPreparer } from "./imageAuth.js";
import { resolveDaimonRuntimeForImage } from "./imageDocker.js";
import { daimonExternalMountEnvironment } from "./mountPolicy.js";

export const daimonHostIntegration: RuntimeHostIntegration = {
  ownsModelCredentials: true,
  handlesImageModelAuth: (method) => method === "grok",
  includeEmptyTargets: true,
  entrypoint: daimonHostEntrypoint,
  prebuiltSystemDeps: ["bubblewrap", "dbus-daemon", "gnome-keyring", "util-linux"],
  generatedSecrets: {
    [DAIMON_CONTROL_TOKEN_ENV]: { bytes: 32, encoding: "base64url" }
  },
  externalMountEnvironment: daimonExternalMountEnvironment,
  profileVolumeName: (id, profile) => daimonProfileRealmVolume(id, profile) ?? undefined,
  async projectSecurityArgs(compiled) {
    return [
      ...DAIMON_DOCKER_RUNTIME_SECURITY_ARGS,
      ...await resolveDaimonCodexNativeSandboxDockerSecurityOptions(compiled)
    ];
  },
  async prepareCredentialDocker(invocation) {
    const pinned = await pinOpaqueDaimonDockerEndpoint({ ...invocation, opaqueDaimonCredentials: true });
    await assertOpaqueDaimonCredentialsHaveNoUserNamespace(pinned);
    return { ...invocation, args: pinned.args, dockerContext: pinned.dockerContext, dockerHost: pinned.dockerHost };
  },
  async prepareImageLaunch({ imageRef, instances, runDocker, securityDirectory }) {
    const prepared = await resolveDaimonRuntimeForImage(imageRef, instances, runDocker, securityDirectory);
    return {
      securityArgs: prepared.securityArgs,
      prepareAuth: createDaimonImageAuthPreparer(prepared.engineDescriptors)
    };
  },
  prepareImageAuth: createDaimonImageAuthPreparer(),
  async localImageReport() {
    const input = process.env[DAIMON_LOCAL_RUNTIME_IDENTITY_ENV]?.trim();
    if (!input) return {};
    const identity = await loadLocalDaimonRuntimeIdentity(input);
    return { local_daimon_runtime: {
      capability_receipt_sha256: identity.capabilityReceipt,
      image_reference: identity.imageReference,
      registry_authority: identity.registryAuthority
    } };
  }
};
