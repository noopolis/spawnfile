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
  it("exposes container metadata for gateway boot", () => {
    expect(picoClawAdapter.container).toEqual({
      configFileName: "config.json",
      configPathEnv: "PICOCLAW_CONFIG",
      homeEnv: "PICOCLAW_HOME",
      instancePaths: {
        configPathTemplate: "<instance-root>/picoclaw/<config-file>",
        homePathTemplate: "<instance-root>/picoclaw",
        workspacePathTemplate: "<instance-root>/picoclaw/workspace"
      },
      port: 18790,
      portEnv: "PICOCLAW_GATEWAY_PORT",
      standaloneBaseImage: "debian:bookworm-slim",
      startCommand: ["picoclaw", "gateway", "--allow-empty"],
      staticEnv: {
        PICOCLAW_GATEWAY_HOST: "0.0.0.0"
      },
      systemDeps: ["bash", "ca-certificates", "curl", "tar"]
    });
  });

  it("emits config with agents.defaults and model_list", async () => {
    const result = await picoClawAdapter.compileAgent(node);
    const configFile = result.files.find((file) => file.path === "config.json");
    expect(configFile).toBeTruthy();

    const config = JSON.parse(configFile!.content);
    expect(config.agents.defaults.model_name).toBe("gpt-4o-mini");
    expect(config.agents.defaults.restrict_to_workspace).toBe(true);
    expect(config.model_list[0].model).toBe("openai/gpt-4o-mini");
    expect(config.model_list[0].api_key).toBe("file://secrets/OPENAI_API_KEY");
    expect(config.model).toBeUndefined();
  });

  it("emits MCP servers as named map", async () => {
    const result = await picoClawAdapter.compileAgent(node);
    const config = JSON.parse(result.files.find((file) => file.path === "config.json")!.content);
    expect(config.tools.mcp.enabled).toBe(true);
    expect(config.tools.mcp.servers.local.command).toBe("node");
  });

  it("emits fallback models and http MCP servers", async () => {
    const result = await picoClawAdapter.compileAgent({
      ...node,
      execution: {
        model: {
          fallback: [{ name: "claude-sonnet-4-5", provider: "anthropic" }],
          primary: {
            name: "gpt-4o-mini",
            provider: "openai"
          }
        }
      },
      mcpServers: [
        {
          auth: { secret: "SEARCH_API_KEY" },
          name: "web",
          transport: "streamable_http",
          url: "https://example.com/mcp"
        }
      ]
    });

    const config = JSON.parse(result.files.find((file) => file.path === "config.json")!.content);
    expect(config.model_list).toHaveLength(2);
    expect(config.model_list[1].model).toBe("anthropic/claude-sonnet-4-5");
    expect(config.model_list[1].api_key).toBe("file://secrets/ANTHROPIC_API_KEY");
    expect(config.tools.mcp.servers.web.type).toBe("http");
    expect(config.tools.mcp.servers.web.url).toBe("https://example.com/mcp");
    expect(config.tools.mcp.servers.web.headers.SEARCH_API_KEY).toBe("");
  });

  it("declares per-target provider secret files for container boot", async () => {
    const [target] = await picoClawAdapter.createContainerTargets?.([
      {
        emittedFiles: (await picoClawAdapter.compileAgent({
          ...node,
          execution: {
            model: {
              fallback: [{ name: "claude-sonnet-4-5", provider: "anthropic" }],
              primary: {
                name: "gpt-4o-mini",
                provider: "openai"
              }
            }
          }
        })).files,
        id: "agent:assistant",
        kind: "agent",
        slug: "assistant",
        value: {
          ...node,
          execution: {
            model: {
              fallback: [{ name: "claude-sonnet-4-5", provider: "anthropic" }],
              primary: {
                name: "gpt-4o-mini",
                provider: "openai"
              }
            }
          }
        }
      }
    ]) ?? [];

    expect(target?.envFiles).toEqual([
      { envName: "OPENAI_API_KEY", relativePath: "secrets/OPENAI_API_KEY" },
      { envName: "ANTHROPIC_API_KEY", relativePath: "secrets/ANTHROPIC_API_KEY" }
    ]);
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
