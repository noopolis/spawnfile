import type { ResolvedAgentNode } from "../../compiler/types.js";
import { listEffectiveExecutionModelTargets } from "../../compiler/modelEnv.js";
import { SpawnfileError } from "../../shared/index.js";

export { renderPiApp } from "./appSource.js";

export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export const PI_AI_PACKAGE_NAME = "@earendil-works/pi-ai";
export const PI_PACKAGE_VERSION = "0.79.9";

export interface PiGeneratedAgent {
  id: string;
  instructions: string;
  model: {
    name: string;
    provider: string;
  };
  name: string;
  schedule?: {
    every?: string;
    kind: "disabled" | "every";
    prompt?: string;
  };
  slug: string;
  tools: string[];
}

const serializeJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const formatDocumentInstructions = (node: ResolvedAgentNode): string =>
  node.docs
    .map((document) => `# ${document.role}\n\n${document.content}`)
    .join("\n\n");

const resolvePiModel = (node: ResolvedAgentNode): PiGeneratedAgent["model"] => {
  const [target] = listEffectiveExecutionModelTargets(node.execution);
  if (!target) {
    return {
      name: "gpt-5.4-mini",
      provider: "openai-codex"
    };
  }

  if (target.endpoint) {
    throw new SpawnfileError(
      "validation_error",
      "Pi runtime does not support custom or local model endpoints yet"
    );
  }

  if (target.provider === "openai" && target.auth.method === "codex") {
    return {
      name: target.name,
      provider: "openai-codex"
    };
  }

  return {
    name: target.name,
    provider: target.provider
  };
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

export const createPiAgentConfig = (
  node: ResolvedAgentNode,
  slug: string,
  id: string
): PiGeneratedAgent => ({
  id,
  instructions: [
    `You are ${node.name}.`,
    node.description,
    formatDocumentInstructions(node),
    "You are running inside a Spawnfile-generated Pi harness application.",
    "Your workspace is isolated to this agent and may contain shared resources as mounted links.",
    "Use the available tools when you need to inspect, create, or modify files.",
    "When you change files, mention their paths in your final response."
  ].filter((part) => part.trim().length > 0).join("\n\n"),
  model: resolvePiModel(node),
  name: node.name,
  ...(resolveSchedule(node) ? { schedule: resolveSchedule(node) } : {}),
  slug,
  tools: ["read", "write", "edit", "bash", "grep", "find", "ls"]
});

export const renderPiPackageJson = (): string =>
  serializeJson({
    dependencies: {
      [PI_AI_PACKAGE_NAME]: PI_PACKAGE_VERSION,
      [PI_PACKAGE_NAME]: PI_PACKAGE_VERSION
    },
    private: true,
    type: "module"
  });

export const renderPiAppConfig = (agents: PiGeneratedAgent[]): string =>
  serializeJson({
    agents,
    version: "spawnfile.pi-app.v1"
  });
