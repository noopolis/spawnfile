import { isDeepStrictEqual } from "node:util";

import { listEffectiveExecutionModelTargets } from "../../compiler/modelEnv.js";
import type { EffectiveModelTarget, ResolvedAgentNode } from "../../compiler/types.js";
import { SpawnfileError } from "../../shared/index.js";
import type { EmittedFile, RuntimeCompileContext } from "../types.js";
import { renderOpenCodeSubagentGuard } from "./subagentsGuard.js";

const directory = "home/spawnfile-subagents";
const guardPath = `${directory}/guard.mjs`;

interface OpenCodeSubagentConfig {
  mode: "subagent";
  description: string;
  model: string;
  prompt: string;
  permission: { "*": "deny"; external_directory: "deny"; read: "deny"; task: "deny" };
}

interface OpenCodeSubagentPlan {
  files: EmittedFile[];
  config: {
    agent?: Record<string, OpenCodeSubagentConfig>;
    permission?: { task: "deny" };
    plugin?: string[];
    subagent_depth?: 1;
  };
  message?: string;
}

function unsupportedChild(node: ResolvedAgentNode, parentModel: EffectiveModelTarget | undefined): string | undefined {
  if (node.runtime.name !== "opencode") return "requires its own runtime";
  if (node.mcpServers.length || node.memory?.length || node.memoryAccess?.length || node.skills.length ||
      node.workspaceResources?.length || node.secrets.length || Object.keys(node.env).length ||
      node.packages?.length || node.subagents.length || node.surfaces || node.expose ||
      (node.schedule && node.schedule.kind !== "disabled") || node.execution?.sandbox || node.training ||
      Object.keys(node.runtime.options).length) {
    return "requires capabilities, state or isolation unavailable to a native text helper";
  }

  const [model, ...fallbacks] = listEffectiveExecutionModelTargets(node.execution);
  if (!model || fallbacks.length || !isDeepStrictEqual(model, parentModel)) {
    return "requires an explicit model route identical to the parent's route";
  }
  if (model.auth.method !== "api_key" && model.auth.method !== "none") {
    return "requires its own native login scope";
  }
  if (model.reasoningEffort !== undefined) return "requires a reasoning variant unavailable to the task tool";
  return undefined;
}

export function buildOpenCodeSubagents(
  parent: ResolvedAgentNode,
  context?: RuntimeCompileContext
): OpenCodeSubagentPlan {
  if (!context) {
    return parent.subagents.length
      ? { files: [], config: { permission: { task: "deny" } }, message: "OpenCode subagents require resolved children" }
      : { files: [], config: {} };
  }

  const declared = new Map(parent.subagents.map(ref => [ref.id, ref.nodeSource]));
  const ids = new Set(context.subagents.map(child => child.id));
  const slugs = new Set(context.subagents.map(child => child.slug));
  const sources = new Set(context.subagents.map(child => child.node.source));
  const count = context.subagents.length;
  if (declared.size !== parent.subagents.length || ids.size !== count || slugs.size !== count || sources.size !== count ||
      declared.size !== count || context.subagents.some(({ id, slug, node }) =>
        declared.get(id) !== node.source || node.source === parent.source || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug))) {
    throw new SpawnfileError("validation_error", `Ambiguous OpenCode subagents for ${parent.name}`);
  }
  if (!count) return { files: [], config: {} };

  const [parentModel] = listEffectiveExecutionModelTargets(parent.execution);
  const agent: Record<string, OpenCodeSubagentConfig> = {};
  const files: EmittedFile[] = [];
  const refusals: string[] = [];
  for (const { id, slug, node } of context.subagents) {
    const reason = unsupportedChild(node, parentModel);
    if (reason || !parentModel) {
      refusals.push(`${id} ${reason ?? "requires a parent model"}`);
      continue;
    }

    const name = `spawnfile-${slug}`;
    const path = `${directory}/${name}.md`;
    const descriptionPath = `${directory}/${name}.description.txt`;
    files.push({
      path,
      content: [
        `You are ${node.name}, the declared Spawnfile helper ${id}.`,
        node.description,
        ...node.docs.map(doc => doc.content)
      ].filter(Boolean).join("\n\n") + "\n"
    });
    if (node.description.trim()) files.push({ path: descriptionPath, content: node.description + "\n" });
    agent[name] = {
      mode: "subagent",
      description: node.description.trim() ? `{file:./${descriptionPath}}` : `Declared Spawnfile text helper ${slug}`,
      model: `${parentModel.provider}/${parentModel.name}`,
      prompt: `{file:./${path}}`,
      permission: { "*": "deny", external_directory: "deny", read: "deny", task: "deny" }
    };
  }

  const names = Object.keys(agent);
  const messages = [
    ...(names.length ? ["OpenCode helpers run as text-only sessions in the parent's workspace and share its declared model route"] : []),
    ...refusals.map(refusal => `OpenCode subagent ${refusal}`)
  ];
  return {
    files: names.length ? [...files, { path: guardPath, content: renderOpenCodeSubagentGuard(names) }] : [],
    config: {
      permission: { task: "deny" },
      ...(names.length ? { agent, plugin: [`./${guardPath}`], subagent_depth: 1 } : {})
    },
    message: messages.join(". ")
  };
}
