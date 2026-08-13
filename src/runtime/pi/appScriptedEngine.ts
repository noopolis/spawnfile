import path from "node:path";

import type { ResolvedAgentNode } from "../../compiler/types.js";

/**
 * The staged in-workspace directory a `scripted`-engine's `engine_command`
 * script is copied into (Piece 5, Slice B). One constant so `adapter.ts`'s
 * file staging and `appTemplate.ts`'s `engine_command` config field always
 * agree on the exact path without threading data between them — both derive
 * it independently from the same `node.runtime.options.engine_command`
 * value via the helpers below.
 */
export const SCRIPTED_ENGINE_STAGED_DIRECTORY = "engine";

/**
 * Reads `node.runtime.options.engine_command` (the fixture-relative path to
 * a `scripted`-engine's canned-reply script) only when this node actually
 * declares `engine: scripted`. Returns `undefined` for every other engine,
 * and for a `scripted` engine missing/blank `engine_command` — that case is
 * rejected earlier by `piAdapter.validateRuntimeOptions` (adapter.ts), so a
 * `ResolvedAgentNode` reaching `compileAgent`/`createPiAgentConfig` with
 * `engine: scripted` always has a valid value here in practice. Checks the
 * raw option directly (rather than calling `resolvePiEngine`) so this module
 * has no dependency on `appTemplate.ts`, which itself imports these helpers.
 */
export const resolveScriptedEngineCommandOption = (
  node: ResolvedAgentNode
): string | undefined => {
  if (node.runtime.options.engine !== "scripted") {
    return undefined;
  }

  const value = node.runtime.options.engine_command;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
};

/**
 * The staged script's path relative to the agent's own workspace root
 * (`<instance-root>/workspace/agents/<slug>/`), shared by `adapter.ts` (to
 * place the staged `EmittedFile`) and `appTemplate.ts`'s
 * `createPiAgentConfig` (to record it as `engine_command` in the generated
 * `pi-app.json`, resolved at runtime by `appCliEnginesSource.ts`'s
 * `runScriptedEngine`).
 */
export const resolveScriptedEngineStagedPath = (
  node: ResolvedAgentNode
): string | undefined => {
  const option = resolveScriptedEngineCommandOption(node);
  return option
    ? path.posix.join(SCRIPTED_ENGINE_STAGED_DIRECTORY, path.posix.basename(option))
    : undefined;
};
