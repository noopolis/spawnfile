import { describe, expect, it } from "vitest";

import { ResolvedAgentNode } from "../../compiler/types.js";

import { tinyClawAdapter } from "./adapter.js";

describe("tinyClawAdapter", () => {
  it("emits settings.json with agents map and workspace", async () => {
    const node: ResolvedAgentNode = {
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
      runtime: { name: "tinyclaw", options: {} },
      secrets: [],
      skills: [],
      source: "/tmp/Spawnfile",
      subagents: []
    };

    const result = await tinyClawAdapter.compileAgent(node);
    const configFile = result.files.find((file) => file.path === "settings.json");
    expect(configFile).toBeTruthy();

    const config = JSON.parse(configFile!.content);
    expect(config.agents.assistant.provider).toBe("anthropic");
    expect(config.agents.assistant.model).toBe("claude-sonnet-4-5");
    expect(config.workspace).toBeTruthy();
    expect(config.agent).toBeUndefined();
  });

  it("marks MCP as degraded when MCP servers are declared", async () => {
    const node: ResolvedAgentNode = {
      docs: [],
      env: {},
      execution: undefined,
      kind: "agent",
      mcpServers: [{ name: "web_search", transport: "streamable_http", url: "https://example.com" }],
      name: "assistant",
      policyMode: null,
      policyOnDegrade: null,
      runtime: { name: "tinyclaw", options: {} },
      secrets: [],
      skills: [],
      source: "/tmp/Spawnfile",
      subagents: []
    };

    const result = await tinyClawAdapter.compileAgent(node);
    expect(result.capabilities.find((capability) => capability.key === "mcp.web_search")?.outcome).toBe(
      "degraded"
    );
  });

  it("compiles a native team artifact with teams map", async () => {
    const result = await tinyClawAdapter.compileTeam?.({
      docs: [],
      kind: "team",
      members: [
        { id: "leader", kind: "agent", nodeSource: "/tmp/a", runtimeName: "tinyclaw" },
        { id: "writer", kind: "agent", nodeSource: "/tmp/b", runtimeName: "tinyclaw" }
      ],
      name: "research-cell",
      policyMode: null,
      policyOnDegrade: null,
      shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
      source: "/tmp/team/Spawnfile",
      structure: { external: ["leader"], leader: "leader", mode: "hierarchical" as const }
    });

    const configFile = result?.files[0];
    expect(configFile?.path).toBe("tinyclaw-team.json");

    const config = JSON.parse(configFile!.content);
    expect(config.teams["research-cell"].leader_agent).toBe("leader");
    expect(config.teams["research-cell"].agents).toEqual(["leader", "writer"]);
  });
});
