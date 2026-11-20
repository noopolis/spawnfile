import { createAgentScaffoldManifest, type AgentScaffoldManifestOptions } from "../manifest/scaffold.js";
import type { RuntimeAgentScaffold } from "./types.js";

export function createWorkspaceAgentScaffold(
  model: Pick<AgentScaffoldManifestOptions, "runtime" | "modelName" | "provider" | "authMethod">
): RuntimeAgentScaffold {
  return {
    manifest: createAgentScaffoldManifest({ ...model, docs: { system: "AGENTS.md" } }),
    files: [{ path: "AGENTS.md", content: "# Agent instructions\n\nDescribe this agent's role and the work it should do.\n" }]
  };
}
