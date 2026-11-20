import { listEffectiveExecutionModelTargets, resolveModelProviderEnvName } from "../../compiler/modelEnv.js";
import type { EffectiveModelTarget, ResolvedAgentNode, ResolvedAgentSurfaces } from "../../compiler/types.js";
import { SpawnfileError } from "../../shared/index.js";

const providers = new Map([
  ["anthropic", { base_url: "https://api.anthropic.com", transport: "anthropic_messages" }],
  ["openai", { base_url: "https://api.openai.com/v1", transport: "codex_responses" }],
  ["openrouter", { base_url: "https://openrouter.ai/api/v1", transport: "chat_completions" }]
]);

export const hermesConfigFile = "config.yaml";
export const hermesSkillRoot = "workspace/skills";
export const hermesProvider = "spawnfile-model";

export function refuse(feature: string): never {
  throw new SpawnfileError("validation_error", `Hermes Agent does not support ${feature}`);
}

export function assertHermesSurfaces(surfaces: ResolvedAgentSurfaces | undefined): void {
  for (const surface of Object.keys(surfaces ?? {})) {
    if (surface !== "moltnet") refuse(`the ${surface} surface`);
  }
}

function routeFor(target: EffectiveModelTarget) {
  if (!target.endpoint) {
    return providers.get(target.provider) ?? refuse(`model provider ${target.provider}`);
  }

  const { base_url, compatibility } = target.endpoint;
  return {
    base_url,
    transport: compatibility === "anthropic" ? "anthropic_messages" : "chat_completions"
  };
}

export function assertHermesModel(target: EffectiveModelTarget): void {
  routeFor(target);
  if (target.reasoningEffort) refuse("execution.model.reasoning_effort");
  if (target.auth.method === "api_key") return;
  if (target.auth.method === "none" && target.endpoint?.compatibility === "openai") return;
  refuse(`${target.auth.method} auth for ${target.provider}`);
}

export function resolveHermesModel(node: ResolvedAgentNode): EffectiveModelTarget {
  const [primary, ...fallbacks] = listEffectiveExecutionModelTargets(node.execution);
  if (!primary) {
    throw new SpawnfileError("validation_error", "Hermes Agent requires a primary execution model");
  }
  if (fallbacks.length) refuse("execution.model.fallback");
  assertHermesModel(primary);
  return primary;
}

export function hermesModelSecret(model: EffectiveModelTarget): string | undefined {
  if (model.auth.method === "api_key") return model.auth.key ?? resolveModelProviderEnvName(model.provider);
}

export function buildHermesConfig(model: EffectiveModelTarget): string {
  const toolsets = ["file", "skills", "terminal"];
  return `${JSON.stringify({
    model: { default: model.name, provider: `custom:${hermesProvider}` },
    providers: {
      [hermesProvider]: { ...routeFor(model), default_model: model.name }
    },
    terminal: { backend: "local", cwd: "<workspace-path>" },
    skills: { external_dirs: ["<workspace-path>/skills", "<workspace-path>/.agents/skills"] },
    platform_toolsets: { cli: toolsets, oneshot: toolsets, acp: toolsets },
    display: { tool_progress: "all" },
    approvals: { mode: "manual", unattended_mode: "deny", cron_mode: "deny" },
    security: { allow_lazy_installs: false }
  }, null, 2)}\n`;
}
