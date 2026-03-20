import { describe, expect, it } from "vitest";

import { ResolvedAgentNode } from "../../compiler/types.js";

import { openClawAdapter } from "./adapter.js";

const createNode = (options: Record<string, unknown> = {}): ResolvedAgentNode => ({
  docs: [],
  env: {},
  execution: {
    model: {
      primary: {
        name: "claude-sonnet-4-5",
        provider: "anthropic"
      }
    }
  },
  kind: "agent",
  mcpServers: [],
  name: "assistant",
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: "openclaw", options },
  secrets: [],
  skills: [],
  source: "/tmp/Spawnfile",
  subagents: [{ id: "critic", nodeSource: "/tmp/subagent/Spawnfile" }]
});

describe("openClawAdapter", () => {
  it("emits config with agents.defaults and gateway", async () => {
    const result = await openClawAdapter.compileAgent(createNode());
    const configFile = result.files.find((file) => file.path === "openclaw.json");
    expect(configFile).toBeTruthy();

    const config = JSON.parse(configFile!.content);
    expect(config.agents.defaults.model).toBe("anthropic/claude-sonnet-4-5");
    expect(config.gateway.mode).toBe("local");
    expect(config.agent).toBeUndefined();
  });

  it("warns when subagents degrade to routed sessions", async () => {
    const result = await openClawAdapter.compileAgent(createNode());

    expect(result.diagnostics[0]?.level).toBe("warn");
    expect(result.capabilities.find((capability) => capability.key === "agent.subagents")?.outcome).toBe(
      "degraded"
    );
  });

  it("validates runtime option types", () => {
    expect(openClawAdapter.validateRuntimeOptions?.({ profile: 123 })).toEqual([
      {
        level: "error",
        message: "OpenClaw runtime option profile must be a string"
      }
    ]);
  });
});
