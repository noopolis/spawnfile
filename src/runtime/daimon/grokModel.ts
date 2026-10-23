import type { ResolvedAgentNode } from "../../compiler/types.js";
import { SpawnfileError } from "../../shared/index.js";
import { DAIMON_BROKER_ENGINE_ID, getDaimonEngineDescriptor, type DaimonEngineDescriptor } from "./engines.js";

import {
  type DaimonGrokBrokerModel,
  type DaimonGrokBrokerReasoningEffort
} from "./contractManifest.js";

export interface DaimonGrokModel {
  model: DaimonGrokBrokerModel;
  reasoningEffort: DaimonGrokBrokerReasoningEffort;
}

/**
 * The declared model of one brokered Daimon Grok agent.
 *
 * Every Grok agent runs through Daimon's engine broker, whose worker
 * `config.toml` bytes are pinned per model x effort and whose provider proxy
 * refuses any request body carrying another pair. Nothing may be inherited: Grok
 * 1.0.34 silently drops an effort a model does not declare and its catalog
 * default for `grok-4.6` is `high`, so the declaration is required in full —
 * `execution.model.primary` with `provider: xai`, a name from Daimon's closed
 * list, a target-level `auth.method: grok`, and `reasoning_effort` — and there
 * is exactly one model (no fallback, no legacy model-level auth).
 */
export const resolveDaimonGrokModel = (
  node: ResolvedAgentNode,
  descriptor: DaimonEngineDescriptor = getDaimonEngineDescriptor(DAIMON_BROKER_ENGINE_ID)!
): DaimonGrokModel => {
  const models = descriptor.modelSelection.models?.kind === "enum" ? descriptor.modelSelection.models.values : [];
  const efforts = descriptor.modelSelection.reasoningEfforts;
  const { provider, method } = descriptor.auth;
  const fail = (detail: string): never => {
    throw new SpawnfileError(
      "validation_error",
      `Daimon Grok agent ${node.name} ${detail}; declare execution.model.primary { provider: ${provider}, name: ${models.join(" | ")}, auth: { method: ${method} }, reasoning_effort: ${efforts.join(" | ")} }`
    );
  };
  const declared = node.execution?.model;
  if (!declared) return fail("must declare its brokered model and reasoning effort");
  if (declared.fallback?.length || declared.auth) fail("must declare exactly one model with target-level auth");
  const primary = declared.primary;
  if (primary.provider !== provider || primary.endpoint || primary.auth?.method !== method) fail(`must use provider ${provider} with auth.method ${method}`);
  if (!models.includes(primary.name)) fail(`declares unsupported model ${primary.name}`);
  const effort = primary.reasoning_effort;
  if (effort === undefined || !efforts.includes(effort)) fail("must declare reasoning_effort");
  return { model: primary.name as DaimonGrokBrokerModel, reasoningEffort: effort as DaimonGrokBrokerReasoningEffort };
};
