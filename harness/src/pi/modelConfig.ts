import { createHash } from "node:crypto";

import type { HarnessModelSpec } from "../core/types.js";

type PiApi = "anthropic-messages" | "openai-completions";

interface PiModelProviderConfig {
  api: PiApi;
  apiKey: string;
  baseUrl: string;
  models: Array<{
    api: PiApi;
    baseUrl: string;
    contextWindow: number;
    cost: {
      cacheRead: number;
      cacheWrite: number;
      input: number;
      output: number;
    };
    id: string;
    input: Array<"image" | "text">;
    maxTokens: number;
    name: string;
    reasoning: boolean;
  }>;
}

export interface PiModelResolution {
  model: {
    name: string;
    provider: string;
  };
  modelsConfig: {
    providers: Record<string, PiModelProviderConfig>;
  };
}

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
};

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const shortHash = (value: string): string =>
  createHash("sha1").update(value).digest("hex").slice(0, 8);

const endpointApi = (compatibility: NonNullable<HarnessModelSpec["endpoint"]>["compatibility"]): PiApi =>
  compatibility === "anthropic" ? "anthropic-messages" : "openai-completions";

const endpointApiKey = (model: HarnessModelSpec): string =>
  model.auth?.method === "api_key"
    ? `$${model.auth.keyEnv ?? `${model.provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`}`
    : "ollama";

const assertSupportedEndpointAuth = (model: HarnessModelSpec): void => {
  const method = model.auth?.method ?? "none";
  if (method === "none" || method === "api_key") {
    return;
  }

  throw new Error(`Pi endpoint models only support none or api_key auth, got ${method}`);
};

export const createPiProviderId = (model: HarnessModelSpec): string => {
  const base = slugify(`${model.provider}-${model.endpoint?.compatibility ?? "builtin"}-${model.name}`);
  return `${base || "model"}-${shortHash(stableStringify(model))}`;
};

export const resolvePiHarnessModel = (model: HarnessModelSpec): PiModelResolution => {
  if (!model.endpoint) {
    return {
      model: {
        name: model.name,
        provider: model.provider === "openai" && model.auth?.method === "codex"
          ? "openai-codex"
          : model.provider
      },
      modelsConfig: { providers: {} }
    };
  }

  assertSupportedEndpointAuth(model);
  const provider = createPiProviderId(model);
  const api = endpointApi(model.endpoint.compatibility);
  return {
    model: {
      name: model.name,
      provider
    },
    modelsConfig: {
      providers: {
        [provider]: {
          api,
          apiKey: endpointApiKey(model),
          baseUrl: model.endpoint.baseUrl,
          models: [
            {
              api,
              baseUrl: model.endpoint.baseUrl,
              contextWindow: 128000,
              cost: {
                cacheRead: 0,
                cacheWrite: 0,
                input: 0,
                output: 0
              },
              id: model.name,
              input: ["text"],
              maxTokens: 16384,
              name: model.name,
              reasoning: false
            }
          ]
        }
      }
    }
  };
};

export const renderPiModelsConfig = (models: HarnessModelSpec[]): string => {
  const providers = new Map<string, PiModelProviderConfig>();

  for (const model of models) {
    const resolution = resolvePiHarnessModel(model);
    for (const [provider, config] of Object.entries(resolution.modelsConfig.providers)) {
      providers.set(provider, config);
    }
  }

  return `${JSON.stringify({
    providers: Object.fromEntries([...providers.entries()].sort(([left], [right]) => left.localeCompare(right)))
  }, null, 2)}\n`;
};
