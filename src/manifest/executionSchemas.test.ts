import { describe, expect, it } from "vitest";

import { executionSchema } from "./executionSchemas.js";

const grokPrimary = { auth: { method: "grok" }, name: "grok-4.6", provider: "xai", reasoning_effort: "low" };

describe("brokered Grok model declarations", () => {
  it("accepts xai grok auth with a closed reasoning effort", () => {
    for (const reasoning_effort of ["low", "medium", "high"]) {
      expect(executionSchema.safeParse({ model: { primary: { ...grokPrimary, reasoning_effort } } }).success).toBe(true);
    }
    const { reasoning_effort: _effort, ...withoutEffort } = grokPrimary;
    // Presence is enforced per engine by the Daimon adapter; the schema only fences where it may appear.
    expect(executionSchema.safeParse({ model: { primary: withoutEffort } }).success).toBe(true);
  });

  it("refuses grok auth off xai, an endpoint, an unknown effort, or an effort on any other auth", () => {
    const invalid = [
      { ...grokPrimary, provider: "openai" },
      { ...grokPrimary, provider: "custom", endpoint: { base_url: "http://127.0.0.1/v1", compatibility: "openai" } },
      { ...grokPrimary, reasoning_effort: "xhigh" },
      { ...grokPrimary, reasoning_effort: "minimal" },
      { auth: { method: "codex" }, name: "gpt-5.4", provider: "openai", reasoning_effort: "low" },
      { auth: { method: "api_key" }, name: "grok-4.6", provider: "xai", reasoning_effort: "low" },
      { name: "grok-4.6", provider: "xai", reasoning_effort: "low" }
    ];
    for (const primary of invalid) {
      expect(executionSchema.safeParse({ model: { primary } }).success, JSON.stringify(primary)).toBe(false);
    }
    // Inherited (model-level) grok auth never carries an effort.
    const { auth: _auth, ...inherited } = grokPrimary;
    expect(executionSchema.safeParse({ model: { auth: { method: "grok" }, primary: inherited } }).success).toBe(false);
  });
});
