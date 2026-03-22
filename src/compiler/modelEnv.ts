import type { ExecutionBlock } from "../manifest/index.js";
import { type ModelAuthMethod, SpawnfileError } from "../shared/index.js";

const MODEL_PROVIDER_ENV_VARS = new Map<string, string>([
  ["anthropic", "ANTHROPIC_API_KEY"],
  ["google", "GOOGLE_API_KEY"],
  ["groq", "GROQ_API_KEY"],
  ["mistral", "MISTRAL_API_KEY"],
  ["openai", "OPENAI_API_KEY"],
  ["openrouter", "OPENROUTER_API_KEY"],
  ["xai", "XAI_API_KEY"]
]);

export const resolveModelProviderEnvName = (provider: string): string =>
  MODEL_PROVIDER_ENV_VARS.get(provider) ??
  `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;

export const listExecutionModelProviders = (
  execution: ExecutionBlock | undefined
): string[] => {
  if (!execution?.model?.primary) {
    return [];
  }

  return [
    execution.model.primary.provider,
    ...(execution.model.fallback ?? []).map((model) => model.provider)
  ]
    .filter((provider, index, providers) => providers.indexOf(provider) === index)
    .sort();
};

export const resolveExecutionModelAuthMethods = (
  execution: ExecutionBlock | undefined
): Record<string, ModelAuthMethod> => {
  const providers = listExecutionModelProviders(execution);
  if (providers.length === 0) {
    return {};
  }

  const auth = execution?.model?.auth;
  if (!auth) {
    return Object.fromEntries(providers.map((provider) => [provider, "api_key"])) as Record<
      string,
      ModelAuthMethod
    >;
  }

  if (auth.method) {
    return Object.fromEntries(
      providers.map((provider) => [provider, auth.method])
    ) as Record<string, ModelAuthMethod>;
  }

  const methods = auth.methods ?? {};
  for (const provider of providers) {
    if (!(provider in methods)) {
      throw new SpawnfileError(
        "validation_error",
        `Model auth methods must declare provider ${provider}`
      );
    }
  }

  for (const provider of Object.keys(methods)) {
    if (!providers.includes(provider)) {
      throw new SpawnfileError(
        "validation_error",
        `Model auth methods declared unknown provider ${provider}`
      );
    }
  }

  return Object.fromEntries(
    providers.map((provider) => [provider, methods[provider]!])
  ) as Record<string, ModelAuthMethod>;
};

export const listExecutionModelSecretNames = (
  execution: ExecutionBlock | undefined
): string[] => {
  const secretNames = new Set<string>();
  const modelAuthMethods = resolveExecutionModelAuthMethods(execution);

  for (const [provider, method] of Object.entries(modelAuthMethods)) {
    if (method !== "api_key") {
      continue;
    }

    secretNames.add(resolveModelProviderEnvName(provider));
  }

  return [...secretNames].sort();
};
