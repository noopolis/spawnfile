import { listEffectiveExecutionModelTargets, resolveModelProviderEnvName } from "../../compiler/modelEnv.js";
import type { EffectiveModelTarget, ResolvedAgentNode } from "../../compiler/types.js";
import { SpawnfileError } from "../../shared/index.js";
import type { RuntimeContainerConfigEnvBinding } from "../types.js";
import { buildHermesSurfaceConfig } from "./surfaces.js";
import { buildHermesMcpConfig } from "./nativeFeatures.js";
import { portalRoutes } from "./login.js";
import { hermesSubscriptions } from "./auth.js";

const providers = new Map([
  ["deepseek", { base_url: "https://api.deepseek.com/v1", transport: "chat_completions" }],
  ["anthropic", { base_url: "https://api.anthropic.com", transport: "anthropic_messages" }],
  ["openai", { base_url: "https://api.openai.com/v1", transport: "codex_responses" }],
  ["openrouter", { base_url: "https://openrouter.ai/api/v1", transport: "chat_completions" }],
  ["xai", { base_url: "https://api.x.ai/v1", transport: "codex_responses" }]
]);

export const hermesConfigFile = "config.yaml";
export const hermesSkillRoot = "workspace/skills";
const hermesProvider = "spawnfile-model";

export function refuse(feature: string): never {
  throw new SpawnfileError("validation_error", `Hermes Agent does not support ${feature}`);
}

function routeFor(target: EffectiveModelTarget) {
  if (!target.endpoint) {
    return providers.get(target.provider) ?? refuse(`model provider ${target.provider}`);
  }

  const { base_url, compatibility } = target.endpoint;
  return { base_url, transport: compatibility === "anthropic" ? "anthropic_messages" : "chat_completions" };
}

function supportedCodexEfforts(model: string): string[] {
  // Mirrors the pinned transport's agent/reasoning_effort.py codex_supported_efforts.
  const name = model.trim().toLowerCase().split("/").at(-1) ?? "";
  const noDisable = ["gpt-6-astra", "gpt-6-astra-900k", "gpt-6.2-astra", "gpt-6.2-sol"].includes(name) ||
    name.startsWith("gpt-6.1-sol");
  const hasMax = noDisable || name.includes("gpt-5.6") || /^(gpt-6-sol|gpt-6-luna)/u.test(name) ||
    ["gpt-daybreak-blue-latest", "gpt-daybreak-blue-latest-900k"].includes(name);
  return [...(noDisable ? [] : ["none"]), "low", "medium", "high", "xhigh", ...(hasMax ? ["max"] : [])];
}

export function assertHermesModel(target: EffectiveModelTarget): void {
  const { method } = target.auth;
  if (method === "subscription" && portalRoutes.has(target.provider) && !target.endpoint && !target.reasoningEffort) return;
  if (method === "codex" || method === "grok") {
    if (target.endpoint || target.provider !== hermesSubscriptions[method].provider) {
      refuse(`${method} auth for ${target.provider} with this route`);
    }
    const efforts = method === "codex" ? supportedCodexEfforts(target.name) : ["low", "medium", "high"];
    if (target.reasoningEffort && !efforts.includes(target.reasoningEffort)) {
      refuse(`reasoning_effort ${target.reasoningEffort} for ${target.name}`);
    }
    return;
  }
  if (method === "claude-code") refuse(`claude-code auth for ${target.provider}`);
  routeFor(target);
  if (target.reasoningEffort) refuse("execution.model.reasoning_effort");
  if (method === "api_key" || (method === "none" && target.endpoint?.compatibility === "openai")) return;
  refuse(`${method} auth for ${target.provider}`);
}

interface HermesRoute {
  provider: string;
  transport: string;
  name?: string;
  base_url?: string;
}

function lowerRoute(model: EffectiveModelTarget, index: number): HermesRoute {
  const { method } = model.auth;
  if (method === "subscription") {
    const route = portalRoutes.get(model.provider) ?? refuse(`subscription for ${model.provider}`);
    return { provider: route.native, transport: route.transport };
  }
  if (method === "codex" || method === "grok") {
    return { provider: hermesSubscriptions[method].native, transport: "codex_responses" };
  }
  const name = index === 0 ? hermesProvider : `${hermesProvider}-${index}`;
  return { provider: `custom:${name}`, name, ...routeFor(model) };
}

export function resolveHermesModels(node: ResolvedAgentNode): [EffectiveModelTarget, ...EffectiveModelTarget[]] {
  const [primary, ...fallbacks] = listEffectiveExecutionModelTargets(node.execution);
  if (!primary) {
    throw new SpawnfileError("validation_error", "Hermes Agent requires a primary execution model");
  }

  const models: [EffectiveModelTarget, ...EffectiveModelTarget[]] = [primary, ...fallbacks];
  const subscriptions = new Set<string>();
  const efforts = new Map<string, string | undefined>();
  for (const model of models) {
    assertHermesModel(model);
    if (model.auth.method === "subscription" || model.auth.method === "codex" || model.auth.method === "grok") subscriptions.add(model.provider);
    const name = model.name.trim().toLowerCase().split("/").at(-1)!.replaceAll(".", "-");
    if (efforts.has(name) && efforts.get(name) !== model.reasoningEffort) {
      refuse("different reasoning_effort values for the same model in a fallback chain");
    }
    efforts.set(name, model.reasoningEffort);
  }
  if (subscriptions.size > 1) refuse("mixed subscription accounts in one fallback chain");
  return models;
}

export function hermesModelBindings(models: EffectiveModelTarget[]): RuntimeContainerConfigEnvBinding[] {
  return models.flatMap((model, index) => {
    if (model.auth.method !== "api_key") return [];
    const { name } = lowerRoute(model, index);
    return [{
      envName: model.auth.key ?? resolveModelProviderEnvName(model.provider),
      jsonPath: ["providers", name!, "api_key"]
    }];
  });
}

export function buildHermesConfig(models: [EffectiveModelTarget, ...EffectiveModelTarget[]], node?: ResolvedAgentNode): string {
  const [model, ...fallbacks] = models;
  const primaryRoute = lowerRoute(model, 0);
  const toolsets = ["file", "skills", "terminal"];
  const customProviders = Object.fromEntries(models.flatMap((target, index) => {
    const { name, base_url, transport } = lowerRoute(target, index);
    return name ? [[name, { base_url, transport, default_model: target.name,
      ...(target.auth.method === "none" ? { api_key: "no-key-required" } : {}) }]] : [];
  }));
  const reasoningOverrides = Object.fromEntries(models.flatMap(target =>
    target.reasoningEffort ? [[target.name, target.reasoningEffort]] : []));

  return `${JSON.stringify({
    ...buildHermesSurfaceConfig(node?.surfaces),
    ...(node ? { mcp_servers: buildHermesMcpConfig(node) } : {}),
    model: { default: model.name, provider: primaryRoute.provider },
    ...(Object.keys(customProviders).length ? { providers: customProviders } : {}),
    ...(fallbacks.length ? { fallback_providers: fallbacks.map((target, index) => {
      const { provider, transport } = lowerRoute(target, index + 1);
      return { model: target.name, provider, transport };
    }) } : {}),
    ...(Object.keys(reasoningOverrides).length ? { agent: { reasoning_overrides: reasoningOverrides } } : {}),
    auth: { adopt_external_logins: false },
    terminal: { backend: "local", cwd: "<workspace-path>" },
    skills: { external_dirs: ["<workspace-path>/skills", "<workspace-path>/.agents/skills"] },
    platform_toolsets: { cli: toolsets, oneshot: toolsets, acp: toolsets, telegram: toolsets, discord: toolsets, slack: toolsets },
    display: { tool_progress: "all" },
    approvals: { mode: "manual", unattended_mode: "deny", cron_mode: "deny" },
    security: { allow_lazy_installs: false }
  }, null, 2)}\n`;
}
