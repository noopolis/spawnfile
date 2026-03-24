import type { ExecutionBlock, ModelTarget } from "../manifest/index.js";
import { type ModelAuthMethod, SpawnfileError } from "../shared/index.js";

import type { EffectiveModelTarget } from "./types.js";

const MODEL_PROVIDER_ENV_VARS = new Map<string, string>([
  ["anthropic", "ANTHROPIC_API_KEY"],
  ["google", "GOOGLE_API_KEY"],
  ["groq", "GROQ_API_KEY"],
  ["mistral", "MISTRAL_API_KEY"],
  ["openai", "OPENAI_API_KEY"],
  ["openrouter", "OPENROUTER_API_KEY"],
  ["xai", "XAI_API_KEY"]
]);

const resolveLegacyModelAuthMethod = (
  execution: ExecutionBlock | undefined,
  provider: string
): ModelAuthMethod | undefined => {
  const auth = execution?.model?.auth;
  if (!auth) {
    return undefined;
  }

  if (auth.method) {
    return auth.method;
  }

  return auth.methods?.[provider];
};

export const resolveModelProviderEnvName = (provider: string): string =>
  MODEL_PROVIDER_ENV_VARS.get(provider) ??
  `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;

export const listExecutionModelTargets = (
  execution: ExecutionBlock | undefined
): ModelTarget[] => {
  if (!execution?.model?.primary) {
    return [];
  }

  return [execution.model.primary, ...(execution.model.fallback ?? [])];
};

const resolveDefaultModelAuthMethod = (target: ModelTarget): ModelAuthMethod | undefined => {
  if (target.provider === "local") {
    return "none";
  }

  if (target.provider === "custom") {
    return undefined;
  }

  return "api_key";
};

export const resolveEffectiveModelTarget = (
  target: ModelTarget,
  execution: ExecutionBlock | undefined
): EffectiveModelTarget => {
  const method =
    target.auth?.method ??
    resolveLegacyModelAuthMethod(execution, target.provider) ??
    resolveDefaultModelAuthMethod(target);

  if (!method) {
    throw new SpawnfileError(
      "validation_error",
      `Model ${target.provider}/${target.name} must declare auth.method`
    );
  }

  if (target.auth?.key && method !== "api_key") {
    throw new SpawnfileError(
      "validation_error",
      `Model ${target.provider}/${target.name} can only declare auth.key with api_key auth`
    );
  }

  if (
    (target.provider === "custom" || target.provider === "local") &&
    !target.endpoint
  ) {
    throw new SpawnfileError(
      "validation_error",
      `Model ${target.provider}/${target.name} must declare endpoint`
    );
  }

  if (
    target.endpoint &&
    target.provider !== "custom" &&
    target.provider !== "local"
  ) {
    throw new SpawnfileError(
      "validation_error",
      `Model ${target.provider}/${target.name} cannot declare endpoint`
    );
  }

  if (
    method === "api_key" &&
    (target.provider === "custom" || target.provider === "local") &&
    !target.auth?.key
  ) {
    throw new SpawnfileError(
      "validation_error",
      `Model ${target.provider}/${target.name} must declare auth.key for api_key auth`
    );
  }

  return {
    auth: {
      ...(target.auth?.key ? { key: target.auth.key } : {}),
      method
    },
    ...(target.endpoint ? { endpoint: target.endpoint } : {}),
    name: target.name,
    provider: target.provider
  };
};

export const listEffectiveExecutionModelTargets = (
  execution: ExecutionBlock | undefined
): EffectiveModelTarget[] => listExecutionModelTargets(execution).map((target) => resolveEffectiveModelTarget(target, execution));

export const listExecutionModelProviders = (
  execution: ExecutionBlock | undefined
): string[] => {
  const providers = listEffectiveExecutionModelTargets(execution).map((target) => target.provider);
  return providers.filter((provider, index) => providers.indexOf(provider) === index).sort();
};

export const resolveExecutionModelAuthMethods = (
  execution: ExecutionBlock | undefined
): Record<string, ModelAuthMethod> => {
  const methods = new Map<string, ModelAuthMethod>();

  for (const target of listEffectiveExecutionModelTargets(execution)) {
    const existingMethod = methods.get(target.provider);
    if (existingMethod && existingMethod !== target.auth.method) {
      throw new SpawnfileError(
        "validation_error",
        `Execution model declares conflicting auth methods for provider ${target.provider}`
      );
    }

    methods.set(target.provider, target.auth.method);
  }

  return Object.fromEntries(
    [...methods.entries()].sort(([left], [right]) => left.localeCompare(right))
  ) as Record<string, ModelAuthMethod>;
};

export const listExecutionModelSecretNames = (
  execution: ExecutionBlock | undefined
): string[] => {
  const secretNames = new Set<string>();

  for (const target of listEffectiveExecutionModelTargets(execution)) {
    if (target.auth.method !== "api_key") {
      continue;
    }

    secretNames.add(target.auth.key ?? resolveModelProviderEnvName(target.provider));
  }

  return [...secretNames].sort();
};
