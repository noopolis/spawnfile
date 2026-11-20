import { resolveModelProviderEnvName, listEffectiveExecutionModelTargets } from "../../compiler/modelEnv.js";
import type { EffectiveModelTarget, ResolvedAgentNode } from "../../compiler/types.js";
import { SpawnfileError } from "../../shared/index.js";
import type { EmittedFile } from "../types.js";
import { opencodeSkillRoots } from "./launch.js";

export function assertOpenCodeModel(target: EffectiveModelTarget): void {
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
  if (!target.endpoint) return { env };

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

function mcpConfig(servers: ResolvedAgentNode["mcpServers"]): Record<string, unknown> {
  return Object.fromEntries(servers.map(server => [
    server.name,
    server.transport === "stdio"
      ? { type: "local", command: [server.command, ...server.args ?? []], environment: server.env }
      : { type: "remote", url: server.url, oauth: false }
  ]));
}

export function openCodeConfig(node: ResolvedAgentNode, docs: EmittedFile[]): string {
  const [primary] = listEffectiveExecutionModelTargets(node.execution);
  if (primary) assertOpenCodeModel(primary);
  const model = primary && `${primary.provider}/${primary.name}`;
  const config = {
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    ...(model && primary ? {
      model,
      small_model: model,
      enabled_providers: [primary.provider],
      provider: { [primary.provider]: providerConfig(primary) }
    } : {}),
    instructions: [
      "<workspace-path>/AGENTS.md",
      ...docs.filter(file => file.path !== "workspace/AGENTS.md")
        .map(file => `<workspace-path>/${file.path.slice("workspace/".length)}`)
    ],
    skills: { paths: opencodeSkillRoots.map(root => `<workspace-path>/${root}`) },
    mcp: mcpConfig(node.mcpServers)
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}
