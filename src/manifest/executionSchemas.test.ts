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

  it("refuses grok auth off xai, an endpoint, an unknown effort, or an effort on unsupported auth", () => {
    const invalid = [
      { ...grokPrimary, provider: "openai" },
      { ...grokPrimary, provider: "custom", endpoint: { base_url: "http://127.0.0.1/v1", compatibility: "openai" } },
      { ...grokPrimary, reasoning_effort: "xhigh" },
      { ...grokPrimary, reasoning_effort: "minimal" },
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

describe("Codex reasoning effort declarations", () => {
  const primary = { auth: { method: "codex" }, name: "gpt-5.4-codex", provider: "openai" };

  it.each(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"])("accepts Daimon's Codex effort %s", (reasoning_effort) => {
    expect(executionSchema.parse({ model: { primary: { ...primary, reasoning_effort } } }).model?.primary.reasoning_effort).toBe(reasoning_effort);
  });

  it("leaves an omitted effort absent", () => {
    expect(executionSchema.parse({ model: { primary } }).model?.primary).not.toHaveProperty("reasoning_effort");
  });

  it.each(["turbo", "", "HIGH", 1, null])("refuses invalid Codex effort %s with a named validation error", (reasoning_effort) => {
    const result = executionSchema.safeParse({ model: { primary: { ...primary, reasoning_effort } } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["model", "primary", "reasoning_effort"]);
      expect(result.error.message).toContain('"persistent"');
    }
  });

  it.each(["api_key", "claude-code", "none", undefined])("refuses effort for auth method %s", (method) => {
    const result = executionSchema.safeParse({ model: { primary: { ...primary, auth: method ? { method } : undefined, reasoning_effort: "low" } } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("auth.method grok or codex");
  });

  it.each(["none", "minimal", "xhigh", "max", "ultra", "persistent"])("still refuses Codex-only effort %s for Grok", (reasoning_effort) => {
    const result = executionSchema.safeParse({ model: { primary: { ...grokPrimary, reasoning_effort } } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]).toMatchObject({ code: "invalid_value", values: ["low", "medium", "high"], path: ["model", "primary", "reasoning_effort"] });
  });
});
