import { fileURLToPath } from "node:url";

import { SpawnfileError } from "../../shared/index.js";
import {
  DAIMON_CONTRACT_MANIFEST_SHA256, DAIMON_DEFAULT_WAKE_TEXT_BYTES,
  readVerifiedDaimonContractManifest, type DaimonContractManifest
} from "./contractManifest.js";

/**
 * Daimon runtime option `max_wake_text_bytes`: the widest wake text one agent's
 * control API admits. Absent keeps Daimon's default bound. An organization's
 * bound is the widest any of its agents declares, because Daimon bounds wake
 * text per organization (`host.maxWakeTextBytes`).
 */
export const resolveDaimonWakeTextBytes = (value: unknown, agentId?: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < DAIMON_DEFAULT_WAKE_TEXT_BYTES) {
    throw new SpawnfileError("validation_error",
      `Daimon runtime option max_wake_text_bytes must be an integer of at least ${DAIMON_DEFAULT_WAKE_TEXT_BYTES}${agentId ? `: ${agentId}` : ""}`);
  }
  return value;
};

/** The pinned Daimon must declare the bound, and the declared value must fit its ceiling. */
export const assertDaimonWakeTextBound = async (bytes: number, injected?: DaimonContractManifest): Promise<void> => {
  let manifest = injected;
  if (manifest === undefined) {
    const verified = await readVerifiedDaimonContractManifest(fileURLToPath(new URL("./", import.meta.url)));
    if (verified.digest !== DAIMON_CONTRACT_MANIFEST_SHA256) throw new SpawnfileError("validation_error",
      "Pinned Daimon contract manifest does not match the capability-receipt digest");
    manifest = verified.manifest;
  }
  const ceiling = manifest.maxWakeTextBytesCeiling;
  if (ceiling === undefined) throw new SpawnfileError("validation_error",
    "The pinned Daimon runtime does not declare host.maxWakeTextBytes; a Daimon release with it and a runtimes.yaml / contract-manifest re-pin are required");
  if (bytes > ceiling) throw new SpawnfileError("validation_error",
    `Daimon runtime option max_wake_text_bytes ${bytes} exceeds the pinned Daimon ceiling ${ceiling}`);
};
