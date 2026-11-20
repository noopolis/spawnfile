import { describe, expect, it } from "vitest";

import { assertRuntimeSupportsExecutionModelAuth } from "../compiler/modelAuth.js";
import { executionSchema } from "../manifest/executionSchemas.js";

import { getRuntimeAdapter } from "./registry.js";

const codexTarget = {
  auth: { method: "codex" as const },
  name: "gpt-5.4-codex",
  provider: "openai"
};
const clawEffortError = /does not support reasoning_effort; only Daimon Codex and Grok engines support it on test-agent/u;

const effortCases = [
  { runtime: "openclaw", primary: codexTarget, error: clawEffortError },
  { runtime: "picoclaw", primary: codexTarget, error: clawEffortError }
];

describe.each(effortCases)("$runtime reasoning effort boundary", ({ runtime, primary, error }) => {
  it.each(["primary", "fallback"])("refuses reasoning_effort on the %s model", (slot) => {
    const withEffort = { ...codexTarget, reasoning_effort: "high" };
    const execution = executionSchema.parse({
      model: slot === "primary"
        ? { primary: withEffort }
        : { primary, fallback: [withEffort] }
    });
    expect(() => assertRuntimeSupportsExecutionModelAuth(runtime, execution, "test-agent"))
      .toThrow(expect.objectContaining({ code: "validation_error", message: expect.stringMatching(error) }));
  });

  it("accepts the supported primary credential without effort", () => {
    expect(() => getRuntimeAdapter(runtime).assertSupportedModelTarget(primary)).not.toThrow();
  });

  it("refuses effort before endpoint auth can return early", () => {
    expect(() => getRuntimeAdapter(runtime).assertSupportedModelTarget({
      auth: { method: "none" },
      endpoint: { base_url: "http://localhost:11434/v1", compatibility: "openai" },
      name: "local-model",
      provider: "local",
      reasoningEffort: "low"
    })).toThrow(/reasoning_effort/u);
  });
});


it.each(["hermes-agent", "opencode"])("%s accepts explicit supported Codex effort on its native route", runtime => {
  const execution = executionSchema.parse({ model: { primary: { ...codexTarget, reasoning_effort: "high" } } });
  expect(() => assertRuntimeSupportsExecutionModelAuth(runtime, execution, "test-agent")).not.toThrow();
  expect(() => getRuntimeAdapter(runtime).assertSupportedModelTarget({
    ...codexTarget, auth: { method: "api_key" }, reasoningEffort: "high"
  })).toThrow(/reasoning_effort/u);
});
