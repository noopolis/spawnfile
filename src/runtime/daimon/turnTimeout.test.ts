import { describe, expect, it } from "vitest";

import type { DaimonContractManifest } from "./contractManifest.js";
import { assertDaimonTurnTimeoutBound, resolveDaimonCliTurnTimeoutMs } from "./turnTimeout.js";

describe("Daimon CLI engine turn timeout", () => {
  it("reads only timeout_ms from a Codex or AGY agent's turn_limits", () => {
    expect(resolveDaimonCliTurnTimeoutMs("agent:a", undefined)).toBeUndefined();
    // Bounds are the pinned manifest's, never the Grok broker's: 2 h passes here and is judged at compile.
    expect(resolveDaimonCliTurnTimeoutMs("agent:a", { timeout_ms: 7_200_000 })).toBe(7_200_000);
    for (const limits of [{}, { max_requests: 4 }, { timeout_ms: 1_000, max_tokens: 10 }, null, []]) {
      expect(() => resolveDaimonCliTurnTimeoutMs("agent:a", limits)).toThrow(/declares only timeout_ms on a Codex or AGY agent: agent:a/u);
    }
    for (const timeout of [0, 1.5, "1800000"]) {
      expect(() => resolveDaimonCliTurnTimeoutMs("agent:a", { timeout_ms: timeout })).toThrow(/timeout_ms must be a positive integer/u);
    }
  });

  it("requires a pinned Daimon that reads the field and a value within its bounds", async () => {
    const manifest = (bounds?: { minimum: number; maximum: number }) => ({ ...(bounds ? { turnTimeoutMsBounds: bounds } : {}) }) as DaimonContractManifest;
    await expect(assertDaimonTurnTimeoutBound("agent:a", 1_800_000, manifest())).rejects.toThrow(/does not read agents\[\]\.engine\.turnTimeoutMs/u);
    await expect(assertDaimonTurnTimeoutBound("agent:a", 1_800_000, manifest({ minimum: 1_000, maximum: 3_600_000 }))).resolves.toBeUndefined();
    await expect(assertDaimonTurnTimeoutBound("agent:a", 3_600_001, manifest({ minimum: 1_000, maximum: 3_600_000 }))).rejects.toThrow(/outside the pinned Daimon bounds/u);
  });
});
