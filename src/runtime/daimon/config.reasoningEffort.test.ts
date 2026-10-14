import { describe, expect, it } from "vitest";

import { resolveEffectiveModelTarget } from "../../compiler/modelEnv.js";
import type { ResolvedAgentNode } from "../../compiler/types.js";
import { executionSchema } from "../../manifest/executionSchemas.js";
import { createPiTestNode } from "../pi/testHelpers.js";

import { daimonAdapter } from "./adapter.js";
import { createDaimonContainerTargets, DAIMON_CONFIG_FILE } from "./config.js";

const emitEngine = async (engine: string, reasoning_effort?: string) => {
  const execution = executionSchema.parse({
    model: {
      primary: {
        auth: { method: engine },
        name: engine === "grok" ? "grok-4.6" : "gpt-5.4-codex",
        provider: engine === "grok" ? "xai" : "openai",
        ...(reasoning_effort === undefined ? {} : { reasoning_effort })
      }
    },
    sandbox: { mode: "workspace" }
  });
  // Exercise the compiler's effective model and adapter validation boundary too.
  const effective = resolveEffectiveModelTarget(execution.model!.primary, execution);
  daimonAdapter.assertSupportedModelTarget!(effective);
  const node: ResolvedAgentNode = createPiTestNode({
    execution,
    runtime: { name: "daimon", options: { engine } }
  });
  const compiled = await daimonAdapter.compileAgent(node);
  const [target] = await createDaimonContainerTargets([
    { emittedFiles: compiled.files, id: "agent:test", kind: "agent", slug: "test", value: node }
  ]);
  const config = JSON.parse(target!.files.find((file) => file.path === DAIMON_CONFIG_FILE)!.content);
  return config.agents[0].engine;
};

describe("Daimon reasoning effort lowering", () => {
  it.each(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"])("lowers declared Codex effort %s", async (reasoningEffort) => {
    expect(await emitEngine("codex", reasoningEffort)).toEqual({ kind: "codex", model: "gpt-5.4-codex", reasoningEffort });
  });

  it("omits Codex effort when absent", async () => {
    expect(await emitEngine("codex")).toEqual({ kind: "codex", model: "gpt-5.4-codex" });
  });

  it.each(["low", "medium", "high"])("keeps Grok engine intent unchanged for %s", async (reasoningEffort) => {
    expect(await emitEngine("grok", reasoningEffort)).toEqual({ kind: "grok", model: "grok-4.6", reasoningEffort });
  });
});
