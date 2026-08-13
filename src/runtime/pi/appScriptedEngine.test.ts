import { describe, expect, it } from "vitest";

import { createPiTestNode } from "./testHelpers.js";
import {
  resolveScriptedEngineCommandOption,
  resolveScriptedEngineStagedPath,
  SCRIPTED_ENGINE_STAGED_DIRECTORY
} from "./appScriptedEngine.js";

describe("resolveScriptedEngineCommandOption", () => {
  it("returns undefined for a non-scripted engine (or no engine option at all)", () => {
    expect(resolveScriptedEngineCommandOption(createPiTestNode())).toBeUndefined();
    expect(
      resolveScriptedEngineCommandOption(
        createPiTestNode({ runtime: { name: "pi", options: { engine: "grok" } } })
      )
    ).toBeUndefined();
  });

  it("returns the raw engine_command option for a scripted engine", () => {
    const node = createPiTestNode({
      runtime: { name: "pi", options: { engine: "scripted", engine_command: "harness/office-engine.mjs" } }
    });

    expect(resolveScriptedEngineCommandOption(node)).toBe("harness/office-engine.mjs");
  });

  it("returns undefined for a scripted engine with a missing or blank engine_command (defensive; validateRuntimeOptions rejects this before compileAgent runs)", () => {
    const missing = createPiTestNode({ runtime: { name: "pi", options: { engine: "scripted" } } });
    const blank = createPiTestNode({
      runtime: { name: "pi", options: { engine: "scripted", engine_command: "   " } }
    });

    expect(resolveScriptedEngineCommandOption(missing)).toBeUndefined();
    expect(resolveScriptedEngineCommandOption(blank)).toBeUndefined();
  });
});

describe("resolveScriptedEngineStagedPath", () => {
  it("joins the staged engine directory with the option's basename", () => {
    const node = createPiTestNode({
      runtime: { name: "pi", options: { engine: "scripted", engine_command: "harness/office-engine.mjs" } }
    });

    expect(resolveScriptedEngineStagedPath(node)).toBe(
      `${SCRIPTED_ENGINE_STAGED_DIRECTORY}/office-engine.mjs`
    );
  });

  it("returns undefined when there is no valid scripted engine_command", () => {
    expect(
      resolveScriptedEngineStagedPath(
        createPiTestNode({ runtime: { name: "pi", options: { engine: "codex" } } })
      )
    ).toBeUndefined();
  });
});
