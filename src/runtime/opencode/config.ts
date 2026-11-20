import { resolveModelProviderEnvName, listEffectiveExecutionModelTargets } from "../../compiler/modelEnv.js";
import type { EffectiveModelTarget, ResolvedAgentNode } from "../../compiler/types.js";
import { SpawnfileError } from "../../shared/index.js";
import type { EmittedFile } from "../types.js";
import { openCodeSubscriptionProvider } from "./auth.js";
import { buildOpenCodeMcpConfig } from "./nativeFeatures.js";
import type { buildOpenCodeSubagents } from "./subagents.js";
import { opencodeSkillRoots } from "./launch.js";

export function assertOpenCodeModel(target: EffectiveModelTarget): void {
  // The pinned native catalog is checked at launch with the selected login.
  if (openCodeSubscriptionProvider(target)) return;
  if (target.auth.method === "claude-code") {
    throw new SpawnfileError("validation_error", "OpenCode has no native Claude Code subscription backend");
  }
  if (target.reasoningEffort !== undefined) {
    throw new SpawnfileError("validation_error", "OpenCode does not lower Spawnfile reasoning_effort to provider-specific variants");
  }
  if (target.auth.method === "api_key") return;
  if (target.auth.method === "none" && target.endpoint?.compatibility === "openai") return;
  throw new SpawnfileError(
    "validation_error",
    `OpenCode does not support ${target.auth.method} auth for ${target.provider}/${target.name}`
  );
}

function providerConfig(target: EffectiveModelTarget): Record<string, unknown> {
  const env = target.auth.method === "api_key"
    ? [target.auth.key ?? resolveModelProviderEnvName(target.provider)]
    : [];
  if (!target.endpoint) {
    if (target.reasoningEffort === undefined) return { env };
    return {
      env,
      // ACP selects the first variant. Restrict the native list to the declared effort.
      models: { [target.name]: { reasoning_options: [{ type: "effort", values: [target.reasoningEffort] }] } }
    };
  }

  return {
    name: target.provider,
    npm: target.endpoint.compatibility === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
    env,
    options: { baseURL: target.endpoint.base_url },
    models: {
      [target.name]: { name: target.name, tool_call: true }
    }
  };
}

export function openCodeConfig(node: ResolvedAgentNode, docs: EmittedFile[], helpers: ReturnType<typeof buildOpenCodeSubagents>["config"] = {}): string {
  const [primary] = listEffectiveExecutionModelTargets(node.execution);
  if (primary) assertOpenCodeModel(primary);
  const model = primary && `${primary.provider}/${primary.name}`;
  const { agent: roles, ...delegation } = helpers;
  const variant = primary?.reasoningEffort;
  const agents = {
    ...roles,
    ...(variant ? { build: { model, variant }, plan: { model, variant } } : {})
  };
  const config = {
    ...delegation,
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    ...(model && primary ? {
      model,
      small_model: model,
      enabled_providers: [primary.provider],
      provider: { [primary.provider]: providerConfig(primary) },
      ...(Object.keys(agents).length ? { agent: agents } : {})
    } : {}),
    instructions: [
      "<workspace-path>/AGENTS.md",
      ...docs.filter(file => file.path !== "workspace/AGENTS.md")
        .map(file => `<workspace-path>/${file.path.slice("workspace/".length)}`)
    ],
    skills: { paths: opencodeSkillRoots.map(root => `<workspace-path>/${root}`) },
    mcp: buildOpenCodeMcpConfig(node)
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}
