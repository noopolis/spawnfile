import { SpawnfileError } from "../../shared/index.js";
import { DAIMON_LOCAL_RUNTIME_IDENTITY_ENV, loadLocalDaimonRuntimeIdentity } from "../localDaimonAuthority.js";

import { DAIMON_CONTRACT_MANIFEST_SHA256 } from "./contractManifest.js";

/**
 * True when the image the build will select attests the compiler's exact
 * contract manifest (organization runtime v2): either the explicit local
 * development identity, or the published registry pin with a digest, its
 * per-architecture capability receipts and a matching contract manifest.
 * The published receipts embed that manifest digest; the generated image
 * re-checks the receipt it copies, so the pin is the attestation.
 */
export const hasDaimonScheduleAuthority = async (): Promise<boolean> => {
  const identityPath = process.env[DAIMON_LOCAL_RUNTIME_IDENTITY_ENV]?.trim();
  if (identityPath) {
    return (await loadLocalDaimonRuntimeIdentity(identityPath)).manifestSha256 ===
      DAIMON_CONTRACT_MANIFEST_SHA256;
  }
  // Lazy: install.js -> registry.js -> this adapter would otherwise form an import cycle.
  const { resolveRuntimeInstallSelection } = await import("../install.js");
  const selection = await resolveRuntimeInstallSelection("daimon");
  return selection.kind === "container_image" &&
    Boolean(selection.digest) &&
    Boolean(selection.capabilityReceipt || selection.capabilityReceipts) &&
    selection.contractManifestSha256 === DAIMON_CONTRACT_MANIFEST_SHA256;
};

/** Schedule lowering is allowed only when the selected image receipt binds v2. */
export const assertDaimonScheduleAuthority = async (): Promise<void> => {
  if (!await hasDaimonScheduleAuthority()) {
    throw new SpawnfileError(
      "runtime_error",
      "Daimon schedules are disabled: the selected image capability receipt does not attest organization runtime v2"
    );
  }
};
