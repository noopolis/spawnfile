import { fileURLToPath } from "node:url";

import { SpawnfileError } from "../../shared/index.js";
import { DAIMON_CONTRACT_MANIFEST_SHA256, readVerifiedDaimonContractManifest, type DaimonContractManifest } from "./contractManifest.js";
import type { DaimonGrokTurnLimits } from "./grokTurnLimits.js";

/**
 * A CLI engine agent's (Codex, AGY) `turn_limits`: only `timeout_ms`, the wall clock
 * one turn may run, lowered to Daimon's per-agent `engine.turnTimeoutMs`. Request and
 * token budgets stay a Grok broker registration. Absent keeps Daimon's engine default.
 */
export const resolveDaimonCliTurnTimeoutMs = (agentId: string, limits: DaimonGrokTurnLimits | undefined): number | undefined => {
  if (limits === undefined) return undefined;
  if (limits.maxRequests !== undefined || limits.maxTokens !== undefined || limits.timeoutMs === undefined) {
    throw new SpawnfileError("validation_error", `Daimon runtime option turn_limits declares only timeout_ms on a Codex or AGY agent: ${agentId}`);
  }
  return limits.timeoutMs;
};

/** The pinned Daimon must read `engine.turnTimeoutMs`, and the declared value must fit its bounds. */
export const assertDaimonTurnTimeoutBound = async (agentId: string, timeoutMs: number, injected?: DaimonContractManifest): Promise<void> => {
  let manifest = injected;
  if (manifest === undefined) {
    const verified = await readVerifiedDaimonContractManifest(fileURLToPath(new URL("./", import.meta.url)));
    if (verified.digest !== DAIMON_CONTRACT_MANIFEST_SHA256) throw new SpawnfileError("validation_error",
      "Pinned Daimon contract manifest does not match the capability-receipt digest");
    manifest = verified.manifest;
  }
  const bounds = manifest.turnTimeoutMsBounds;
  if (bounds === undefined) throw new SpawnfileError("validation_error",
    "The pinned Daimon runtime does not read agents[].engine.turnTimeoutMs; a Daimon release with it and a runtimes.yaml / contract-manifest re-pin are required");
  if (timeoutMs < bounds.minimum || timeoutMs > bounds.maximum) throw new SpawnfileError("validation_error",
    `Daimon runtime option turn_limits.timeout_ms ${timeoutMs} is outside the pinned Daimon bounds ${bounds.minimum} to ${bounds.maximum}: ${agentId}`);
};
