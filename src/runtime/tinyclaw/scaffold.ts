import type { RuntimeAgentScaffold } from "../types.js";
import { createAgentScaffoldManifest } from "../../manifest/index.js";
import { loadRuntimeScaffoldAsset } from "../scaffoldAssets.js";

export const createTinyClawAgentScaffold = (): RuntimeAgentScaffold => ({
  files: [
    {
      content: loadRuntimeScaffoldAsset(import.meta.url, "SOUL.md"),
      path: "SOUL.md"
    },
    {
      content: loadRuntimeScaffoldAsset(import.meta.url, "AGENTS.md"),
      path: "AGENTS.md"
    }
  ],
  manifest: createAgentScaffoldManifest({
    authMethod: "claude-code",
    docs: {
      soul: "SOUL.md",
      system: "AGENTS.md"
    },
    modelName: "claude-sonnet-4-6",
    provider: "anthropic",
    runtime: "tinyclaw"
  })
});
