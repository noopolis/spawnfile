import type { ModelAuthMethod } from "../shared/index.js";

export type E2ERuntime = "openclaw" | "picoclaw" | "tinyclaw";
export type E2EFixtureKind = "agent" | "team";
export type E2EScenarioKind = "single-agent" | "team";

export interface E2EAgentSpec {
  authMethod: ModelAuthMethod;
  directoryName: string;
  modelName: string;
  name: string;
  provider: string;
  runtime: E2ERuntime;
}

export interface E2EPromptCheck {
  agentName?: string;
  runtime: E2ERuntime;
}

export interface DockerAuthE2EScenario {
  agents: E2EAgentSpec[];
  description: string;
  fixture: E2EFixtureKind;
  id: string;
  kind: E2EScenarioKind;
  promptChecks: E2EPromptCheck[];
}

export interface DockerAuthE2EFilters {
  authMethods?: ModelAuthMethod[];
  runtimes?: E2ERuntime[];
  scenarioIds?: string[];
}

export interface DockerAuthE2EScenarioResult {
  durationMs: number;
  errorMessage?: string;
  id: string;
  success: boolean;
}
