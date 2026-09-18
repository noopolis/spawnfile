import type { ResolvedAgentNode } from "../../compiler/types.js";
import { SpawnfileError } from "../../shared/index.js";

import {
  DAIMON_GROK_BROKER_MODELS,
  DAIMON_GROK_BROKER_REASONING_EFFORTS,
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
export const resolveDaimonGrokModel = (node: ResolvedAgentNode): DaimonGrokModel => {
  const fail = (detail: string): never => {
    throw new SpawnfileError(
      "validation_error",
      `Daimon Grok agent ${node.name} ${detail}; declare execution.model.primary { provider: xai, name: ${DAIMON_GROK_BROKER_MODELS.join(" | ")}, auth: { method: grok }, reasoning_effort: ${DAIMON_GROK_BROKER_REASONING_EFFORTS.join(" | ")} }`
    );
  };
  const declared = node.execution?.model;
  if (!declared) return fail("must declare its brokered model and reasoning effort");
  if (declared.fallback?.length || declared.auth) fail("must declare exactly one model with target-level auth");
  const primary = declared.primary;
  if (primary.provider !== "xai" || primary.endpoint || primary.auth?.method !== "grok") fail("must use provider xai with auth.method grok");
  if (!(DAIMON_GROK_BROKER_MODELS as readonly string[]).includes(primary.name)) fail(`declares unsupported model ${primary.name}`);
  const effort = primary.reasoning_effort;
  if (effort === undefined || !(DAIMON_GROK_BROKER_REASONING_EFFORTS as readonly string[]).includes(effort)) fail("must declare reasoning_effort");
  return { model: primary.name as DaimonGrokBrokerModel, reasoningEffort: effort as DaimonGrokBrokerReasoningEffort };
};
