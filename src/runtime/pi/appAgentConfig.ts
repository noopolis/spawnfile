import path from "node:path";

import type { ResolvedAgentNode } from "../../compiler/types.js";
import type { SimfileWorldBindingV1 } from "../../compiler/worldBindings.js";
import {
  listEffectiveExecutionModelTargets,
  resolveModelProviderEnvName
} from "../../compiler/modelEnv.js";
import { createShortHash, slugify, stableStringify } from "../../compiler/helpers.js";
import { SpawnfileError } from "../../shared/index.js";

import { resolveScriptedEngineStagedPath } from "./appScriptedEngine.js";
import {
  PI_BUILTIN_TOOLS,
  PI_ENGINE_KINDS,
  PI_HARNESS_SYSTEM_PROMPT,
  PI_THINKING_FORMATS,
  PI_THINKING_LEVELS,
  type PiGeneratedAgent
} from "./appTemplateTypes.js";

interface PiModelProviderConfig {
  api: "anthropic-messages" | "openai-completions";
  apiKey: string;
  baseUrl: string;
  models: Array<{
    api: "anthropic-messages" | "openai-completions";
    baseUrl: string;
    contextWindow: number;
    cost: {
      cacheRead: number;
      cacheWrite: number;
      input: number;
      output: number;
    };
    id: string;
    input: string[];
    maxTokens: number;
    name: string;
    reasoning: boolean;
    compat?: {
      thinkingFormat: typeof PI_THINKING_FORMATS[number];
    };
    thinkingLevelMap?: {
      high: "high";
      low: "low";
      medium: "medium";
      minimal: "low";
      off: "none";
      xhigh: "max";
    };
  }>;
}

const serializeJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const isPiEveryScheduleValue = (value: string): boolean =>
  /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/u.test(value.trim());

const isPiEngineKind = (value: unknown): value is typeof PI_ENGINE_KINDS[number] =>
  typeof value === "string" && (PI_ENGINE_KINDS as readonly string[]).includes(value);

const isPiThinkingLevel = (value: unknown): value is typeof PI_THINKING_LEVELS[number] =>
  typeof value === "string" && (PI_THINKING_LEVELS as readonly string[]).includes(value);

const isPiThinkingFormat = (value: unknown): value is typeof PI_THINKING_FORMATS[number] =>
  typeof value === "string" && (PI_THINKING_FORMATS as readonly string[]).includes(value);

const formatDocumentInstructions = (node: ResolvedAgentNode): string =>
  node.docs
    .map((document) => `# ${document.role}\n\n${document.content}`)
    .join("\n\n");

const createCustomProviderId = (
  target: ReturnType<typeof listEffectiveExecutionModelTargets>[number]
): string => {
  const base = slugify(`${target.provider}-${target.endpoint?.compatibility ?? "builtin"}-${target.name}`);
  return `${base || "model"}-${createShortHash(stableStringify({
    auth: target.auth,
    endpoint: target.endpoint,
    name: target.name,
    provider: target.provider
  }))}`;
};

const resolveEndpointApi = (
  compatibility: "anthropic" | "openai"
): PiModelProviderConfig["api"] =>
  compatibility === "anthropic" ? "anthropic-messages" : "openai-completions";

const OPENAI_THINKING_LEVEL_MAP = Object.freeze({
  high: "high",
  low: "low",
  medium: "medium",
  minimal: "low",
  off: "none",
  xhigh: "max"
} as const);

const resolveEndpointApiKey = (
  target: ReturnType<typeof listEffectiveExecutionModelTargets>[number]
): string =>
  target.auth.method === "api_key"
    ? `$${target.auth.key ?? resolveModelProviderEnvName(target.provider)}`
    : "ollama";

const resolvePiModel = (node: ResolvedAgentNode): PiGeneratedAgent["model"] => {
  const [target] = listEffectiveExecutionModelTargets(node.execution);
  if (!target) {
    return {
      auth_method: "codex",
      name: "gpt-5.4-mini",
      provider: "openai-codex"
    };
  }

  if (target.endpoint) {
    return {
      auth_method: target.auth.method,
      name: target.name,
      provider: createCustomProviderId(target)
    };
  }

  if (target.provider === "openai" && target.auth.method === "codex") {
    return {
      auth_method: target.auth.method,
      name: target.name,
      provider: "openai-codex"
    };
  }

  return {
    auth_method: target.auth.method,
    name: target.name,
    provider: target.provider
  };
};

export const resolvePiEngine = (
  node: ResolvedAgentNode
): PiGeneratedAgent["engine"] => {
  const value = node.runtime.options.engine;
  if (value === undefined) {
    return { kind: "pi" };
  }

  if (isPiEngineKind(value)) {
    return { kind: value };
  }

  throw new SpawnfileError(
    "validation_error",
    `Pi runtime option engine must be one of ${PI_ENGINE_KINDS.join(", ")}`
  );
};

export const resolvePiThinkingLevel = (
  node: ResolvedAgentNode
): PiGeneratedAgent["thinking_level"] | undefined => {
  const value = node.runtime.options.thinking;
  if (value === undefined) return undefined;
  if (isPiThinkingLevel(value)) return value;
  throw new SpawnfileError(
    "validation_error",
    `Pi runtime option thinking must be one of ${PI_THINKING_LEVELS.join(", ")}`
  );
};

export const resolvePiTools = (node: ResolvedAgentNode): string[] => {
  const value = node.runtime.options.tools;
  if (value === undefined) return [...PI_BUILTIN_TOOLS];
  if (Array.isArray(value)
    && value.every((item): item is typeof PI_BUILTIN_TOOLS[number] =>
      typeof item === "string"
      && (PI_BUILTIN_TOOLS as readonly string[]).includes(item))
    && new Set(value).size === value.length) {
    return [...value];
  }
  throw new SpawnfileError(
    "validation_error",
    `Pi runtime option tools must contain unique values from ${PI_BUILTIN_TOOLS.join(", ")}`
  );
};

export const resolvePiThinkingFormat = (
  node: ResolvedAgentNode
): typeof PI_THINKING_FORMATS[number] | undefined => {
  const value = node.runtime.options.thinking_format;
  if (value === undefined) return undefined;
  if (isPiThinkingFormat(value)) return value;
  throw new SpawnfileError(
    "validation_error",
    `Pi runtime option thinking_format must be one of ${PI_THINKING_FORMATS.join(", ")}`
  );
};

export const resolvePiRawTrainingCapture = (
  node: ResolvedAgentNode
): PiGeneratedAgent["raw_training_capture"] | undefined => {
  const value = node.runtime.options.raw_training_capture_turns;
  if (value === undefined) return undefined;
  if (Number.isSafeInteger(value)
    && typeof value === "number"
    && value >= 1
    && value <= 100_000) {
    return {
      enabled: true,
      retention: { maxTurns: value }
    };
  }
  throw new SpawnfileError(
    "validation_error",
    "Pi runtime option raw_training_capture_turns must be an integer between 1 and 100000"
  );
};

export const renderPiModelsConfig = (nodes: ResolvedAgentNode[]): string => {
  const providers = new Map<string, PiModelProviderConfig>();

  for (const node of nodes) {
    for (const target of listEffectiveExecutionModelTargets(node.execution)) {
      if (!target.endpoint) {
        continue;
      }

      const providerId = createCustomProviderId(target);
      const api = resolveEndpointApi(target.endpoint.compatibility);
      const provider = providers.get(providerId) ?? {
        api,
        apiKey: resolveEndpointApiKey(target),
        baseUrl: target.endpoint.base_url,
        models: []
      };

      if (!provider.models.some((model) => model.id === target.name)) {
        const explicitOpenAiThinking =
          target.endpoint.compatibility === "openai"
          && node.runtime.options.thinking !== undefined;
        const thinkingFormat = resolvePiThinkingFormat(node);
        provider.models.push({
          api,
          baseUrl: target.endpoint.base_url,
          contextWindow: 128000,
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          id: target.name,
          input: ["text"],
          maxTokens: 16384,
          name: target.name,
          reasoning: explicitOpenAiThinking,
          ...(thinkingFormat === undefined || thinkingFormat === "openai"
            ? {}
            : { compat: { thinkingFormat } }),
          ...(explicitOpenAiThinking
            ? { thinkingLevelMap: OPENAI_THINKING_LEVEL_MAP }
            : {})
        });
      }

      providers.set(providerId, provider);
    }
  }

  return serializeJson({
    providers: Object.fromEntries(
      [...providers.entries()].sort(([left], [right]) => left.localeCompare(right))
    )
  });
};

const resolveSchedule = (
  node: ResolvedAgentNode
): PiGeneratedAgent["schedule"] | undefined => {
  if (!node.schedule || node.schedule.kind === "disabled") {
    return node.schedule ? { kind: "disabled" } : undefined;
  }

  if (node.schedule.kind === "every") {
    return {
      every: node.schedule.every,
      kind: "every",
      ...(node.schedule.prompt ? { prompt: node.schedule.prompt } : {})
    };
  }

  return undefined;
};

const resolveMemoryRuntimeHomePath = (node: ResolvedAgentNode): PiGeneratedAgent["memory"] | undefined => {
  const [access] = [...(node.memoryAccess ?? [])].sort((left, right) =>
    `${left.source}:${left.bank.id}`.localeCompare(`${right.source}:${right.bank.id}`)
  );
  if (!access) {
    return undefined;
  }

  const store = access.bank.store;
  if (store.kind === "postgres") {
    return undefined;
  }

  const vector = access.bank.index?.vector;
  const embedding = vector?.enabled && vector.model && (!vector.provider || vector.provider === "ollama")
    ? {
      ...(vector.base_url ? { base_url: vector.base_url } : {}),
      ...(vector.dimensions ? { dimensions: vector.dimensions } : {}),
      model: vector.model,
      provider: "ollama" as const,
      ...(vector.timeout_ms ? { timeout_ms: vector.timeout_ms } : {})
    }
    : undefined;

  if (store.kind === "memory") {
    return {
      bank_id: access.bank.id,
      ...(resolveMemoryConsolidation(access) ? { consolidation: resolveMemoryConsolidation(access) } : {}),
      ...(embedding ? { embedding } : {}),
      runtime_home_path: `/var/lib/spawnfile/memory/${slugify(access.bank.declaredName) || "memory"}/${access.bank.id}`,
      source: `spawnfile:${access.declaringKind}:${access.bank.id}`
    };
  }

  const runtimeHomePath = store.persistence?.mount ?? path.posix.dirname(store.path ?? "");
  if (!runtimeHomePath) {
    return undefined;
  }

  return {
    bank_id: access.bank.id,
    ...(resolveMemoryConsolidation(access) ? { consolidation: resolveMemoryConsolidation(access) } : {}),
    ...(embedding ? { embedding } : {}),
    runtime_home_path: runtimeHomePath,
    source: `spawnfile:${access.declaringKind}:${access.bank.id}`
  };
};

const resolveMemoryConsolidation = (
  access: NonNullable<ResolvedAgentNode["memoryAccess"]>[number]
): NonNullable<PiGeneratedAgent["memory"]>["consolidation"] | undefined => {
  if (access.bank.consolidation.mode !== "scheduled" || !access.bank.consolidation.schedule) {
    return undefined;
  }
  if (!isPiEveryScheduleValue(access.bank.consolidation.schedule)) {
    return undefined;
  }

  return {
    every: access.bank.consolidation.schedule,
    kind: "every",
    prompt: [
      `Dream over Mneme memory bank ${access.bank.id}.`,
      "Search the active dream scope and read-only global scope for stale, duplicate, noisy, or important memories.",
      "Use memory_summarize, memory_register, or memory_forget only when consolidation is evidence-backed."
    ].join(" ")
  };
};

export const createPiAgentConfig = (
  node: ResolvedAgentNode,
  slug: string,
  id: string,
  worldBinding?: SimfileWorldBindingV1
): PiGeneratedAgent => {
  const engineCommand = resolveScriptedEngineStagedPath(node);
  const engine = resolvePiEngine(node);
  const thinkingLevel = resolvePiThinkingLevel(node);
  const rawTrainingCapture = resolvePiRawTrainingCapture(node);
  return {
    engine,
    ...(engineCommand ? { engine_command: engineCommand } : {}),
    id,
    instructions: [
      `You are ${node.name}.`,
      node.description,
      formatDocumentInstructions(node),
      PI_HARNESS_SYSTEM_PROMPT
    ].filter((part) => part.trim().length > 0).join("\n\n"),
    model: resolvePiModel(node),
    ...(resolveMemoryRuntimeHomePath(node) ? { memory: resolveMemoryRuntimeHomePath(node) } : {}),
    name: node.name,
    ...(rawTrainingCapture ? { raw_training_capture: rawTrainingCapture } : {}),
    ...(resolveSchedule(node) ? { schedule: resolveSchedule(node) } : {}),
    slug,
    ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
    tools: resolvePiTools(node),
    ...(worldBinding && engine.kind === "pi"
      ? { world: { url: worldBinding.json.url, tokenEnv: worldBinding.token_env } }
      : {})
  };
};
