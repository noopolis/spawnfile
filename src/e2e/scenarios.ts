import type { ModelAuthMethod } from "../shared/index.js";

import type {
  DockerAuthE2EFilters,
  DockerAuthE2EScenario,
  E2EAgentSpec,
  E2ERuntime
} from "./types.js";

const createSingleAgentScenario = (
  runtime: E2ERuntime,
  provider: string,
  modelName: string,
  authMethod: ModelAuthMethod
): DockerAuthE2EScenario => {
  const id = `${runtime}-${authMethod}`;
  const agent: E2EAgentSpec = {
    authMethod,
    directoryName: runtime,
    modelName,
    name: `${runtime}-assistant`,
    provider,
    runtime
  };

  return {
    agents: [agent],
    description: `${runtime} single-agent Docker auth smoke using ${authMethod}`,
    fixture: "agent",
    id,
    kind: "single-agent",
    promptChecks: [{ runtime }]
  };
};

const SINGLE_AGENT_SCENARIOS: DockerAuthE2EScenario[] = [
  createSingleAgentScenario("openclaw", "openai", "gpt-5", "api_key"),
  createSingleAgentScenario("openclaw", "openai", "gpt-5", "codex"),
  createSingleAgentScenario("openclaw", "anthropic", "claude-sonnet-4-5", "claude-code"),
  createSingleAgentScenario("picoclaw", "openai", "gpt-5", "api_key"),
  createSingleAgentScenario("picoclaw", "openai", "gpt-5", "codex"),
  createSingleAgentScenario("picoclaw", "anthropic", "claude-sonnet-4-5", "claude-code"),
  createSingleAgentScenario("tinyclaw", "openai", "gpt-5", "codex"),
  createSingleAgentScenario("tinyclaw", "anthropic", "claude-sonnet-4-5", "claude-code")
];

const TEAM_SCENARIOS: DockerAuthE2EScenario[] = [
  {
    agents: [
      {
        authMethod: "codex",
        directoryName: "openclaw",
        modelName: "gpt-5",
        name: "openclaw",
        provider: "openai",
        runtime: "openclaw"
      },
      {
        authMethod: "api_key",
        directoryName: "picoclaw",
        modelName: "gpt-5",
        name: "picoclaw",
        provider: "openai",
        runtime: "picoclaw"
      },
      {
        authMethod: "codex",
        directoryName: "tinyclaw",
        modelName: "gpt-5",
        name: "tinyclaw",
        provider: "openai",
        runtime: "tinyclaw"
      }
    ],
    description: "multi-runtime Docker auth smoke team",
    fixture: "team",
    id: "team-multi-runtime",
    kind: "team",
    promptChecks: [
      { runtime: "openclaw" },
      { runtime: "picoclaw" },
      { agentName: "tinyclaw", runtime: "tinyclaw" }
    ]
  }
];

export const listDockerAuthE2EScenarios = (): DockerAuthE2EScenario[] => [
  ...SINGLE_AGENT_SCENARIOS,
  ...TEAM_SCENARIOS
];

const includesScenarioId = (
  filters: DockerAuthE2EFilters,
  scenario: DockerAuthE2EScenario
): boolean =>
  !filters.scenarioIds ||
  filters.scenarioIds.length === 0 ||
  filters.scenarioIds.includes(scenario.id);

const includesAuthMethod = (
  filters: DockerAuthE2EFilters,
  scenario: DockerAuthE2EScenario
): boolean =>
  !filters.authMethods ||
  filters.authMethods.length === 0 ||
  scenario.agents.some((agent) => filters.authMethods!.includes(agent.authMethod));

const includesRuntime = (
  filters: DockerAuthE2EFilters,
  scenario: DockerAuthE2EScenario
): boolean =>
  !filters.runtimes ||
  filters.runtimes.length === 0 ||
  scenario.agents.some((agent) => filters.runtimes!.includes(agent.runtime));

export const filterDockerAuthE2EScenarios = (
  filters: DockerAuthE2EFilters = {}
): DockerAuthE2EScenario[] =>
  listDockerAuthE2EScenarios().filter(
    (scenario) =>
      includesScenarioId(filters, scenario) &&
      includesAuthMethod(filters, scenario) &&
      includesRuntime(filters, scenario)
  );
