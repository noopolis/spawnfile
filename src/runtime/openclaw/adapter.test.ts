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
  it("exposes container metadata for gateway boot", () => {
    expect(openClawAdapter.container).toEqual({
      configFileName: "openclaw.json",
      configPathEnv: "OPENCLAW_CONFIG_PATH",
      env: [
        {
          description: "Gateway auth token required for non-loopback OpenClaw access",
          name: "OPENCLAW_GATEWAY_TOKEN",
          required: true
        }
      ],
      homeEnv: "OPENCLAW_HOME",
      instancePaths: {
        configPathTemplate: "<instance-root>/home/.openclaw/<config-file>",
        homePathTemplate: "<instance-root>/home",
        workspacePathTemplate: "<instance-root>/home/.openclaw/workspace"
      },
      port: 18789,
      portEnv: "OPENCLAW_GATEWAY_PORT",
      standaloneBaseImage: "node:24-bookworm-slim",
      startCommand: [
        "node",
        "<runtime-root>/openclaw.mjs",
        "gateway",
        "--allow-unconfigured",
        "--bind",
        "lan",
        "--port",
        "<port>",
        "--verbose"
      ],
      systemDeps: ["bash", "ca-certificates", "curl", "git", "hostname", "openssl", "procps"]
    });
  });

  it("emits config with agents.defaults and gateway", async () => {
    const result = await openClawAdapter.compileAgent(createNode());
    const configFile = result.files.find((file) => file.path === "openclaw.json");
    expect(configFile).toBeTruthy();

    const config = JSON.parse(configFile!.content);
    expect(config.agents.defaults.model).toBe("anthropic/claude-sonnet-4-5");
    expect(config.gateway.mode).toBe("local");
    expect(config.gateway.bind).toBe("lan");
    expect(config.gateway.auth.mode).toBe("token");
    expect(config.agent).toBeUndefined();
  });

  it("warns when subagents degrade to routed sessions", async () => {
    const result = await openClawAdapter.compileAgent(createNode());

    expect(result.diagnostics[0]?.level).toBe("warn");
    expect(result.capabilities.find((capability) => capability.key === "agent.subagents")?.outcome).toBe(
      "degraded"
    );
  });

  it("emits a generated provider catalog entry for custom endpoints", async () => {
    const customResult = await openClawAdapter.compileAgent({
      ...createNode(),
      execution: {
        model: {
          primary: {
            auth: {
              key: "CUSTOM_API_KEY",
              method: "api_key"
            },
            endpoint: {
              base_url: "https://llm.example.com/v1",
              compatibility: "anthropic"
            },
            name: "foo-large",
            provider: "custom"
          }
        }
      }
    });
    const config = JSON.parse(
      customResult.files.find((file) => file.path === "openclaw.json")!.content
    );

    expect(customResult.files.find((file) => file.path === "openclaw.json")).toBeTruthy();
    expect(config.agents.defaults.model).toBe("spawnfile-custom/foo-large");
    expect(config.models.providers["spawnfile-custom"].baseUrl).toBe("https://llm.example.com/v1");
    expect(config.models.providers["spawnfile-custom"].apiKey).toEqual({
      id: "CUSTOM_API_KEY",
      provider: "default",
      source: "env"
    });
    expect(config.models.providers["spawnfile-custom"].api).toBe("anthropic-messages");
  });

  it("validates supported and unsupported model target combinations", () => {
    expect(() =>
      openClawAdapter.assertSupportedModelTarget({
        auth: { method: "claude-code" },
        name: "claude-opus-4-6",
        provider: "anthropic"
      })
    ).not.toThrow();

    expect(() =>
      openClawAdapter.assertSupportedModelTarget({
        auth: { method: "none" },
        name: "qwen2.5:14b",
        provider: "ollama"
      })
    ).not.toThrow();

    expect(() =>
      openClawAdapter.assertSupportedModelTarget({
        auth: { method: "codex" },
        endpoint: {
          base_url: "https://llm.example.com/v1",
          compatibility: "openai"
        },
        name: "foo-large",
        provider: "custom"
      })
    ).toThrow(/do not support codex auth/);
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
