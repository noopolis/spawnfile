import { SpawnfileError } from "../../shared/index.js";
import { DAIMON_LOCAL_RUNTIME_IDENTITY_ENV, loadLocalDaimonRuntimeIdentity } from "../localDaimonAuthority.js";

import { DAIMON_CONTRACT_MANIFEST_SHA256 } from "./contractManifest.js";

export const hasDaimonScheduleAuthority = async (): Promise<boolean> => {
  const identityPath = process.env[DAIMON_LOCAL_RUNTIME_IDENTITY_ENV]?.trim();
  if (!identityPath) return false;
  return (await loadLocalDaimonRuntimeIdentity(identityPath)).manifestSha256 ===
    DAIMON_CONTRACT_MANIFEST_SHA256;
};

/** Schedule lowering is allowed only when the selected image receipt binds v2. */
export const assertDaimonScheduleAuthority = async (): Promise<void> => {
  // The checked-in v0.2.0 production pin attests v1 only.
  if (!await hasDaimonScheduleAuthority()) {
    throw new SpawnfileError(
      "runtime_error",
      "Daimon schedules are disabled: the selected image capability receipt does not attest organization runtime v2"
    );
  }
};
