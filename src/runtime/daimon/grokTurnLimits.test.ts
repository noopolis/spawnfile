import { describe, expect, it } from "vitest";

import { DAIMON_GROK_ENGINE_BROKER } from "./contractManifest.js";
import { resolveDaimonGrokRegistrationLimits, resolveDaimonGrokTurnLimits } from "./grokTurnLimits.js";

describe("Daimon Grok turn limits", () => {
  const bounds = DAIMON_GROK_ENGINE_BROKER.turnLimits.bounds;

  it("accepts a declared budget inside the contract's own bounds", () => {
    expect(resolveDaimonGrokTurnLimits({ max_tokens: 1_100_000, timeout_ms: 900_000 }))
      .toEqual({ maxTokens: 1_100_000, timeoutMs: 900_000 });
    expect(resolveDaimonGrokTurnLimits(undefined)).toBeUndefined();
  });

  it("refuses anything the broker would not honour", () => {
    for (const value of [null, [], "900000", 900_000]) {
      expect(() => resolveDaimonGrokTurnLimits(value)).toThrow(/turn_limits must be an object/u);
    }
    expect(() => resolveDaimonGrokTurnLimits({})).toThrow(/at least one limit/u);
    expect(() => resolveDaimonGrokTurnLimits({ max_wakes: 4 })).toThrow(/turn_limits.max_wakes is unsupported/u);
    expect(() => resolveDaimonGrokTurnLimits({ max_tokens: bounds.maxTokens[1] + 1 })).toThrow(/max_tokens must be an integer/u);
    expect(() => resolveDaimonGrokTurnLimits({ timeout_ms: bounds.timeoutMs[0] - 1 })).toThrow(/timeout_ms must be an integer/u);
    expect(() => resolveDaimonGrokTurnLimits({ max_requests: bounds.maxRequests[1] + 1 })).toThrow(/max_requests must be an integer/u);
    expect(() => resolveDaimonGrokTurnLimits({ max_tokens: 1.5 })).toThrow(/max_tokens must be an integer/u);
  });

  /**
   * The registration is what the broker enforces and what a wake may only lower, so an
   * undeclared agent has to keep exactly the contract's defaults — a silent change here would
   * move every existing organization's budget without anyone declaring it.
   */
  it("keeps the contract defaults for what an agent did not declare", () => {
    expect(resolveDaimonGrokRegistrationLimits(undefined)).toEqual(DAIMON_GROK_ENGINE_BROKER.turnLimits.v1Defaults);
    expect(resolveDaimonGrokRegistrationLimits({ maxTokens: 1_100_000 })).toEqual({
      ...DAIMON_GROK_ENGINE_BROKER.turnLimits.v1Defaults,
      maxTokens: 1_100_000
    });
    expect(resolveDaimonGrokRegistrationLimits({ maxRequests: 40, maxTokens: 2_000_000, timeoutMs: 900_000 }))
      .toEqual({ maxRequests: 40, maxTokens: 2_000_000, timeoutMs: 900_000 });
  });
});
