import { describe, expect, it } from "vitest";

import { ResolvedAgentNode } from "../../compiler/types.js";

import { tinyClawAdapter } from "./adapter.js";

describe("tinyClawAdapter", () => {
  it("exposes container metadata for API boot", () => {
    expect(tinyClawAdapter.container).toEqual({
      configFileName: "settings.json",
      homeEnv: "TINYAGI_HOME",
      instancePaths: {
        configPathTemplate: "<instance-root>/tinyagi/<config-file>",
        homePathTemplate: "<instance-root>/tinyagi",
        workspacePathTemplate: "<instance-root>/workspace"
      },
      port: 3777,
      portEnv: "TINYAGI_API_PORT",
      standaloneBaseImage: "node:22-bookworm-slim",
      startCommand: ["node", "<runtime-root>/packages/main/dist/index.js"],
      systemDeps: ["bash", "ca-certificates", "git"]
    });
  });

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

  it("merges agent and team artifacts into one container target", async () => {
    const assistantNode: ResolvedAgentNode = {
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
      source: "/tmp/assistant/Spawnfile",
      subagents: []
    };
    const writerNode: ResolvedAgentNode = {
      ...assistantNode,
      name: "writer",
      source: "/tmp/writer/Spawnfile"
    };

    const assistantFiles = await tinyClawAdapter.compileAgent(assistantNode);
    const writerFiles = await tinyClawAdapter.compileAgent(writerNode);
    const teamFiles = await tinyClawAdapter.compileTeam?.({
      docs: [],
      kind: "team",
      members: [
        { id: "assistant", kind: "agent", nodeSource: "/tmp/a", runtimeName: "tinyclaw" },
        { id: "writer", kind: "agent", nodeSource: "/tmp/b", runtimeName: "tinyclaw" }
      ],
      name: "research-cell",
      policyMode: null,
      policyOnDegrade: null,
      shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
      source: "/tmp/team/Spawnfile",
      structure: { external: [], leader: "assistant", mode: "hierarchical" }
    });

    const targets = await tinyClawAdapter.createContainerTargets?.([
      {
        emittedFiles: assistantFiles.files,
        id: "agent:assistant",
        kind: "agent",
        slug: "assistant",
        value: assistantNode
      },
      {
        emittedFiles: writerFiles.files,
        id: "agent:writer",
        kind: "agent",
        slug: "writer",
        value: writerNode
      },
      {
        emittedFiles: teamFiles?.files ?? [],
        id: "team:research-cell",
        kind: "team",
        slug: "research-cell",
        value: {
          docs: [],
          kind: "team",
          members: [
            { id: "assistant", kind: "agent", nodeSource: "/tmp/a", runtimeName: "tinyclaw" },
            { id: "writer", kind: "agent", nodeSource: "/tmp/b", runtimeName: "tinyclaw" }
          ],
          name: "research-cell",
          policyMode: null,
          policyOnDegrade: null,
          shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
          source: "/tmp/team/Spawnfile",
          structure: { external: [], leader: "assistant", mode: "hierarchical" }
        }
      }
    ]);

    expect(targets).toHaveLength(1);
    expect(targets?.[0]?.id).toBe("tinyclaw-runtime");

    const settingsFile = targets?.[0]?.files.find((file) => file.path === "settings.json");
    const settings = JSON.parse(settingsFile?.content ?? "{}");
    expect(Object.keys(settings.agents)).toEqual(["assistant", "writer"]);
    expect(settings.teams["research-cell"].leader_agent).toBe("assistant");
  });

  it("returns no container targets when no agent artifacts are present", async () => {
    const targets = await tinyClawAdapter.createContainerTargets?.([
      {
        emittedFiles: [],
        id: "team:research-cell",
        kind: "team",
        slug: "research-cell",
        value: {
          docs: [],
          kind: "team",
          members: [],
          name: "research-cell",
          policyMode: null,
          policyOnDegrade: null,
          shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
          source: "/tmp/team/Spawnfile",
          structure: { external: [], leader: null, mode: "swarm" }
        }
      }
    ]);

    expect(targets).toEqual([]);
  });

  it("ignores team inputs without a native team artifact when merging container targets", async () => {
    const node: ResolvedAgentNode = {
      docs: [],
      env: {},
      execution: undefined,
      kind: "agent",
      mcpServers: [],
      name: "assistant",
      policyMode: null,
      policyOnDegrade: null,
      runtime: { name: "tinyclaw", options: {} },
      secrets: [],
      skills: [],
      source: "/tmp/assistant/Spawnfile",
      subagents: []
    };

    const compiled = await tinyClawAdapter.compileAgent(node);
    const targets = await tinyClawAdapter.createContainerTargets?.([
      {
        emittedFiles: compiled.files,
        id: "agent:assistant",
        kind: "agent",
        slug: "assistant",
        value: node
      },
      {
        emittedFiles: [],
        id: "team:research-cell",
        kind: "team",
        slug: "research-cell",
        value: {
          docs: [],
          kind: "team",
          members: [{ id: "assistant", kind: "agent", nodeSource: "/tmp/a", runtimeName: "tinyclaw" }],
          name: "research-cell",
          policyMode: null,
          policyOnDegrade: null,
          shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
          source: "/tmp/team/Spawnfile",
          structure: { external: [], leader: "assistant", mode: "hierarchical" }
        }
      }
    ]);

    const settings = JSON.parse(
      targets?.[0]?.files.find((file) => file.path === "settings.json")?.content ?? "{}"
    );
    expect(settings.teams).toBeUndefined();
  });
});
