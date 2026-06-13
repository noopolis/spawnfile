import type { ResolvedAgentNode } from "../../compiler/types.js";
import { listEffectiveExecutionModelTargets } from "../../compiler/modelEnv.js";

export interface OpenClawImportAuthModes {
  useClaudeCode: boolean;
  useCodex: boolean;
}

/** Determines which import-based auth modes an agent's models declare. */
export const resolveOpenClawImportAuthModes = (
  node: ResolvedAgentNode
): OpenClawImportAuthModes => {
  const targets = listEffectiveExecutionModelTargets(node.execution);
  return {
    useClaudeCode: targets.some(
      (target) => target.provider === "anthropic" && target.auth.method === "claude-code"
    ),
    useCodex: targets.some(
      (target) => target.provider === "openai" && target.auth.method === "codex"
    )
  };
};

export const normalizeOpenClawCodexModel = (model: string): string => {
  const modelName = model.slice("openai/".length);
  return modelName === "gpt-5" ? "gpt-5.4" : modelName;
};

/**
 * Applies the import-auth structure (OAuth profiles, provider order, and the
 * Codex model rename) to an OpenClaw config. This is deterministic from the
 * declared auth methods, so it is baked into the image at compile time. Only
 * the OAuth credential tokens are injected at run time.
 */
export const applyOpenClawImportAuthConfig = (
  config: Record<string, unknown>,
  modes: OpenClawImportAuthModes
): Record<string, unknown> => {
  if (!modes.useClaudeCode && !modes.useCodex) {
    return config;
  }

  const agents = (config.agents as Record<string, unknown> | undefined) ?? {};
  const defaults = (agents.defaults as Record<string, unknown> | undefined) ?? {};
  const model = defaults.model;
  const auth = (config.auth as Record<string, unknown> | undefined) ?? {};
  const profiles = (auth.profiles as Record<string, unknown> | undefined) ?? {};
  const order = (auth.order as Record<string, unknown> | undefined) ?? {};

  if (modes.useCodex && typeof model === "string" && model.startsWith("openai/")) {
    defaults.model = `openai-codex/${normalizeOpenClawCodexModel(model)}`;
  }

  if (modes.useClaudeCode) {
    profiles["anthropic:default"] = { mode: "oauth", provider: "anthropic" };
    order.anthropic = ["anthropic:default"];
  }

  if (modes.useCodex) {
    profiles["openai-codex:default"] = { mode: "oauth", provider: "openai-codex" };
    order["openai-codex"] = ["openai-codex:default"];
  }

  return {
    ...config,
    agents: { ...agents, defaults },
    auth: { ...auth, order, profiles }
  };
};
