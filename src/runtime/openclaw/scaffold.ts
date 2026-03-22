import type { RuntimeAgentScaffold } from "../types.js";
import { createAgentScaffoldManifest } from "../../manifest/index.js";
import { loadRuntimeScaffoldAsset } from "../scaffoldAssets.js";

export const createOpenClawAgentScaffold = (): RuntimeAgentScaffold => ({
  files: [
    {
      content: loadRuntimeScaffoldAsset(import.meta.url, "IDENTITY.md"),
      path: "IDENTITY.md"
    },
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
    docs: {
      identity: "IDENTITY.md",
      soul: "SOUL.md",
      system: "AGENTS.md"
    },
    modelName: "claude-opus-4-6",
    provider: "anthropic",
    runtime: "openclaw"
  })
});
