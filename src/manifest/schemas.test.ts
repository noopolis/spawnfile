import { describe, expect, it } from "vitest";

import { isAgentManifest, isTeamManifest, manifestSchema } from "./schemas.js";

describe("manifestSchema", () => {
  it("accepts stdio MCP servers with a command", () => {
    const result = manifestSchema.parse({
      kind: "agent",
      mcp_servers: [
        {
          command: "uvx",
          name: "memory",
          transport: "stdio"
        }
      ],
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(isAgentManifest(result)).toBe(true);
  });

  it("rejects stdio MCP servers without a command", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      mcp_servers: [
        {
          name: "memory",
          transport: "stdio"
        }
      ],
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("must declare command");
  });

  it("rejects remote MCP servers without a url", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      mcp_servers: [
        {
          name: "search",
          transport: "sse"
        }
      ],
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("must declare url");
  });

  it("identifies team manifests", () => {
    const result = manifestSchema.parse({
      kind: "team",
      members: [
        {
          id: "analyst",
          ref: "./agents/analyst"
        }
      ],
      name: "research-team",
      spawnfile_version: "0.1",
      structure: {
        mode: "swarm"
      }
    });

    expect(isTeamManifest(result)).toBe(true);
  });

  it("rejects team manifests that declare execution", () => {
    const result = manifestSchema.safeParse({
      execution: {
        model: {
          primary: {
            name: "claude-opus-4-6",
            provider: "anthropic"
          }
        }
      },
      kind: "team",
      members: [
        {
          id: "writer",
          ref: "./agents/writer"
        }
      ],
      name: "research-team",
      spawnfile_version: "0.1",
      structure: {
        mode: "swarm"
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("team manifests must not declare execution");
  });

  it("accepts per-model auth and endpoint config for custom models", () => {
    const result = manifestSchema.parse({
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
            name: "claude-sonnet-4-6",
            provider: "custom"
          }
        }
      },
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(isAgentManifest(result)).toBe(true);
  });

  it("accepts Discord surfaces on agent manifests", () => {
    const result = manifestSchema.parse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        discord: {
          access: {
            guilds: ["123456789012345678"],
            mode: "allowlist",
            users: ["987654321098765432"]
          }
        }
      }
    });

    expect(isAgentManifest(result)).toBe(true);
  });

  it("accepts Telegram surfaces on agent manifests", () => {
    const result = manifestSchema.parse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        telegram: {
          access: {
            chats: ["-1001234567890"],
            mode: "allowlist",
            users: ["123456789"]
          }
        }
      }
    });

    expect(isAgentManifest(result)).toBe(true);
  });

  it("infers Discord allowlist mode from declared users", () => {
    const result = manifestSchema.parse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        discord: {
          access: {
            users: ["987654321098765432"]
          }
        }
      }
    });

    expect(isAgentManifest(result)).toBe(true);
  });

  it("infers Telegram allowlist mode from declared users", () => {
    const result = manifestSchema.parse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        telegram: {
          access: {
            users: ["123456789"]
          }
        }
      }
    });

    expect(isAgentManifest(result)).toBe(true);
  });

  it("rejects Discord allowlist access without any allowlist entries", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        discord: {
          access: {
            mode: "allowlist"
          }
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "discord allowlist access must declare users, guilds, or channels"
    );
  });

  it("rejects Telegram allowlist access without any allowlist entries", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        telegram: {
          access: {
            mode: "allowlist"
          }
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "telegram allowlist access must declare users or chats"
    );
  });

  it("accepts Discord open access without allowlist entries", () => {
    const result = manifestSchema.parse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        discord: {
          access: {
            mode: "open"
          }
        }
      }
    });

    expect(isAgentManifest(result)).toBe(true);
  });

  it("accepts Telegram open access without allowlist entries", () => {
    const result = manifestSchema.parse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        telegram: {
          access: {
            mode: "open"
          }
        }
      }
    });

    expect(isAgentManifest(result)).toBe(true);
  });

  it("rejects Discord users on non-allowlist access", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        discord: {
          access: {
            mode: "pairing",
            users: ["987654321098765432"]
          }
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "discord access users, guilds, and channels are only valid for allowlist mode"
    );
  });

  it("rejects Telegram allowlist entries on non-allowlist access", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        telegram: {
          access: {
            mode: "pairing",
            chats: ["-1001234567890"],
            users: ["123456789"]
          }
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "telegram access users and chats are only valid for allowlist mode"
    );
  });

  it("rejects empty Discord access blocks", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        discord: {
          access: {}
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "discord access must declare mode or allowlist entries"
    );
  });

  it("rejects empty Telegram access blocks", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        telegram: {
          access: {}
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "telegram access must declare mode or allowlist entries"
    );
  });

  it("rejects team manifests that declare surfaces", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "writer",
          ref: "./agents/writer"
        }
      ],
      name: "research-team",
      spawnfile_version: "0.1",
      structure: {
        mode: "swarm"
      },
      surfaces: {
        discord: {}
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("team manifests must not declare surfaces");
  });

  it("rejects custom api_key models without auth.key", () => {
    const result = manifestSchema.safeParse({
      execution: {
        model: {
          primary: {
            auth: {
              method: "api_key"
            },
            endpoint: {
              base_url: "https://llm.example.com/v1",
              compatibility: "openai"
            },
            name: "foo-large",
            provider: "custom"
          }
        }
      },
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("must declare auth.key");
  });

  it("accepts local models with endpoint and implicit none auth", () => {
    const result = manifestSchema.parse({
      execution: {
        model: {
          primary: {
            endpoint: {
              base_url: "http://host.docker.internal:11434/v1",
              compatibility: "openai"
            },
            name: "qwen2.5:14b",
            provider: "local"
          }
        }
      },
      kind: "agent",
      name: "agent",
      runtime: "picoclaw",
      spawnfile_version: "0.1"
    });

    expect(isAgentManifest(result)).toBe(true);
  });

  it("rejects built-in providers with endpoint overrides", () => {
    const result = manifestSchema.safeParse({
      execution: {
        model: {
          primary: {
            endpoint: {
              base_url: "https://proxy.example.com/v1",
              compatibility: "openai"
            },
            name: "gpt-5.4",
            provider: "openai"
          }
        }
      },
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("endpoint is only valid");
  });

  it("rejects legacy auth.methods that omit a declared provider", () => {
    const result = manifestSchema.safeParse({
      execution: {
        model: {
          auth: {
            methods: {
              openai: "codex"
            }
          },
          fallback: [
            {
              name: "claude-opus-4-6",
              provider: "anthropic"
            }
          ],
          primary: {
            name: "gpt-5.4",
            provider: "openai"
          }
        }
      },
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("must declare provider anthropic");
  });

  it("rejects legacy auth.methods that declare unknown providers", () => {
    const result = manifestSchema.safeParse({
      execution: {
        model: {
          auth: {
            methods: {
              anthropic: "claude-code",
              google: "api_key",
              openai: "codex"
            }
          },
          fallback: [
            {
              name: "claude-opus-4-6",
              provider: "anthropic"
            }
          ],
          primary: {
            name: "gpt-5.4",
            provider: "openai"
          }
        }
      },
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("declared unknown provider google");
  });
});
