import { describe, expect, it } from "vitest";

import { ResolvedAgentNode } from "../../compiler/types.js";

import { picoClawAdapter } from "./adapter.js";

const node: ResolvedAgentNode = {
  docs: [],
  env: {},
  execution: {
    model: {
      primary: {
        name: "gpt-4o-mini",
        provider: "openai"
      }
    }
  },
  kind: "agent",
  mcpServers: [{ name: "local", transport: "stdio", command: "node" }],
  name: "assistant",
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: "picoclaw", options: { restrict_to_workspace: true } },
  secrets: [],
  skills: [],
  source: "/tmp/Spawnfile",
  subagents: []
};

describe("picoClawAdapter", () => {
  it("emits config with agents.defaults and model_list", async () => {
    const result = await picoClawAdapter.compileAgent(node);
    const configFile = result.files.find((file) => file.path === "config.json");
    expect(configFile).toBeTruthy();

    const config = JSON.parse(configFile!.content);
    expect(config.agents.defaults.model_name).toBe("gpt-4o-mini");
    expect(config.agents.defaults.restrict_to_workspace).toBe(true);
    expect(config.model_list[0].model).toBe("openai/gpt-4o-mini");
    expect(config.model).toBeUndefined();
  });

  it("emits MCP servers as named map", async () => {
    const result = await picoClawAdapter.compileAgent(node);
    const config = JSON.parse(result.files.find((file) => file.path === "config.json")!.content);
    expect(config.tools.mcp.enabled).toBe(true);
    expect(config.tools.mcp.servers.local.command).toBe("node");
  });

  it("validates runtime option types", () => {
    expect(
      picoClawAdapter.validateRuntimeOptions?.({ restrict_to_workspace: "yes" })
    ).toEqual([
      {
        level: "error",
        message: "PicoClaw runtime option restrict_to_workspace must be a boolean"
      }
    ]);
  });
});
