import { SpawnfileError } from "../../shared/index.js";
import { DAIMON_LOCAL_RUNTIME_IDENTITY_ENV, loadLocalDaimonRuntimeIdentity } from "./localDaimonAuthority.js";

import { DAIMON_DREAM_SCHEDULE_MANIFEST_SHA256, isSupportedDaimonManifestDigest } from "./contractManifest.js";

/**
 * The generated image verifies the same manifest and receipt that identify
 * the scheduler at compile time. An explicit local identity takes precedence.
 */
const selectedScheduleManifestDigest = async (): Promise<string | undefined> => {
  const identityPath = process.env[DAIMON_LOCAL_RUNTIME_IDENTITY_ENV]?.trim();
  if (identityPath) {
    return (await loadLocalDaimonRuntimeIdentity(identityPath)).manifestSha256;
  }
  // Lazy: install.js -> registry.js -> this adapter would otherwise form an import cycle.
  const { resolveRuntimeInstallSelection } = await import("../install.js");
  const selection = await resolveRuntimeInstallSelection("daimon");
  if (selection.kind !== "container_image" || !selection.digest || !(selection.capabilityReceipt || selection.capabilityReceipts)) return undefined;
  return selection.contractManifestSha256;
};

export const hasDaimonScheduleAuthority = async (): Promise<boolean> =>
  isSupportedDaimonManifestDigest(await selectedScheduleManifestDigest());

export const hasDaimonDreamScheduleAuthority = async (): Promise<boolean> =>
  (await selectedScheduleManifestDigest()) === DAIMON_DREAM_SCHEDULE_MANIFEST_SHA256;

/** Schedule lowering is allowed only when the selected image receipt binds v2. */
export const assertDaimonScheduleAuthority = async (): Promise<void> => {
  if (!await hasDaimonScheduleAuthority()) {
    throw new SpawnfileError(
      "runtime_error",
      "Daimon schedules are disabled: the selected image capability receipt does not attest organization runtime v2"
    );
  }
};
