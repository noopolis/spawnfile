import { describe, expect, it } from "vitest";

import { assertRuntimeSupportsExecutionModelAuth } from "../compiler/modelAuth.js";
import { executionSchema } from "../manifest/executionSchemas.js";

import { getRuntimeAdapter, listRuntimeAdapters } from "./registry.js";

const otherRuntimes = listRuntimeAdapters().filter((runtime) => runtime !== "daimon");

const codexTarget = {
  auth: { method: "codex" as const },
  name: "gpt-5.4-codex",
  provider: "openai"
};

describe.each(otherRuntimes)("%s reasoning effort boundary", (runtime) => {
  it.each(["primary", "fallback"])("refuses reasoning_effort on the %s model", (slot) => {
    const withEffort = { ...codexTarget, reasoning_effort: "high" };
    const execution = executionSchema.parse({
      model: slot === "primary"
        ? { primary: withEffort }
        : { primary: codexTarget, fallback: [withEffort] }
    });
    expect(() => assertRuntimeSupportsExecutionModelAuth(runtime, execution, "test-agent"))
      .toThrow(expect.objectContaining({
        code: "validation_error",
        message: expect.stringMatching(/does not support reasoning_effort; only Daimon Codex and Grok engines support it on test-agent/u)
      }));
  });

  it("keeps Codex targets without effort supported", () => {
    expect(() => getRuntimeAdapter(runtime).assertSupportedModelTarget(codexTarget)).not.toThrow();
  });

  it("refuses effort before endpoint auth can return early", () => {
    expect(() => getRuntimeAdapter(runtime).assertSupportedModelTarget({
      auth: { method: "none" },
      endpoint: { base_url: "http://localhost:11434/v1", compatibility: "openai" },
      name: "local-model",
      provider: "local",
      reasoningEffort: "low"
    })).toThrow(/does not support reasoning_effort/u);
  });
});
