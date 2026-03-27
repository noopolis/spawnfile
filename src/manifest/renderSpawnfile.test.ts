import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { renderSpawnfile } from "./renderSpawnfile.js";
import { createAgentScaffoldManifest } from "./scaffold.js";
import { manifestSchema } from "./schemas.js";

describe("renderSpawnfile", () => {
  it("renders a valid agent manifest as YAML", () => {
    const source = renderSpawnfile({
      docs: {
        system: "AGENTS.md"
      },
      execution: {
        model: {
          auth: {
            method: "api_key"
          },
          primary: {
            name: "claude-sonnet-4-5",
            provider: "anthropic"
          }
        },
        sandbox: {
          mode: "workspace"
        },
        workspace: {
          isolation: "isolated"
        }
      },
      kind: "agent",
      name: "my-agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(source).toContain("runtime: openclaw");
    expect(
      manifestSchema.parse(YAML.parse(source) as unknown)
    ).toMatchObject({
      kind: "agent",
      runtime: "openclaw"
    });
  });

  it("renders scaffold manifests in canonical top-level order", () => {
    const source = renderSpawnfile(
      createAgentScaffoldManifest({
        docs: {
          identity: "IDENTITY.md",
          soul: "SOUL.md",
          system: "AGENTS.md"
        },
        modelName: "claude-opus-4-6",
        provider: "anthropic",
        runtime: "openclaw"
      })
    );

    const spawnfileVersionIndex = source.indexOf("spawnfile_version:");
    const kindIndex = source.indexOf("kind: agent");
    const nameIndex = source.indexOf("name: my-agent");
    const runtimeIndex = source.indexOf("runtime: openclaw");
    const executionIndex = source.indexOf("execution:");
    const docsIndex = source.indexOf("docs:");

    expect(spawnfileVersionIndex).toBeGreaterThanOrEqual(0);
    expect(kindIndex).toBeGreaterThan(spawnfileVersionIndex);
    expect(nameIndex).toBeGreaterThan(kindIndex);
    expect(runtimeIndex).toBeGreaterThan(nameIndex);
    expect(executionIndex).toBeGreaterThan(runtimeIndex);
    expect(docsIndex).toBeGreaterThan(executionIndex);
    expect(source).toContain("      name: claude-opus-4-6");
    expect(source).toContain("      provider: anthropic");
    expect(source).not.toContain("  workspace:");
    expect(source).not.toContain("  sandbox:");
    expect(source).toContain("  identity: IDENTITY.md");
    expect(source).toContain("  soul: SOUL.md");
    expect(source).toContain("  system: AGENTS.md");
    expect(source).toContain('name: my-agent\n\nruntime: openclaw\n\nexecution:');
    expect(source).toContain("      provider: anthropic\n      name: claude-opus-4-6\n\ndocs:");
  });

  it("renders rewritten agent manifests with subagents in canonical order", () => {
    const source = renderSpawnfile({
      docs: {
        identity: "IDENTITY.md",
        soul: "SOUL.md",
        system: "AGENTS.md"
      },
      execution: {
        model: {
          primary: {
            name: "claude-opus-4-6",
            provider: "anthropic"
          }
        }
      },
      kind: "agent",
      name: "my-agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      subagents: [
        {
          id: "pepito",
          ref: "./subagents/pepito"
        }
      ]
    });

    const spawnfileVersionIndex = source.indexOf("spawnfile_version:");
    const kindIndex = source.indexOf("kind: agent");
    const nameIndex = source.indexOf("name: my-agent");
    const runtimeIndex = source.indexOf("runtime: openclaw");
    const executionIndex = source.indexOf("execution:");
    const docsIndex = source.indexOf("docs:");
    const subagentsIndex = source.indexOf("subagents:");

    expect(spawnfileVersionIndex).toBeGreaterThanOrEqual(0);
    expect(kindIndex).toBeGreaterThan(spawnfileVersionIndex);
    expect(nameIndex).toBeGreaterThan(kindIndex);
    expect(runtimeIndex).toBeGreaterThan(nameIndex);
    expect(executionIndex).toBeGreaterThan(runtimeIndex);
    expect(docsIndex).toBeGreaterThan(executionIndex);
    expect(subagentsIndex).toBeGreaterThan(docsIndex);
    expect(source).toContain("name: my-agent\n\nruntime: openclaw\n\nexecution:");
    expect(source).toContain("docs:\n  identity: IDENTITY.md");
    expect(source).toContain("system: AGENTS.md\n\nsubagents:");
  });

  it("renders surfaces after docs in canonical order", () => {
    const source = renderSpawnfile({
      docs: {
        system: "AGENTS.md"
      },
      execution: {
        model: {
          primary: {
            name: "claude-opus-4-6",
            provider: "anthropic"
          }
        }
      },
      kind: "agent",
      name: "discord-agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        discord: {
          access: {
            mode: "allowlist",
            users: ["987654321098765432"],
            guilds: ["123456789012345678"],
            channels: ["555555555555555555"]
          },
          bot_token_secret: "TEAM_DISCORD_TOKEN"
        }
      }
    });

    const docsIndex = source.indexOf("docs:");
    const surfacesIndex = source.indexOf("surfaces:");

    expect(docsIndex).toBeGreaterThanOrEqual(0);
    expect(surfacesIndex).toBeGreaterThan(docsIndex);
    expect(source).toContain(
      [
        "surfaces:",
        "  discord:",
        "    access:",
        "      mode: allowlist",
        "      users:",
        "        - \"987654321098765432\"",
        "      guilds:",
        "        - \"123456789012345678\"",
        "      channels:",
        "        - \"555555555555555555\"",
        "    bot_token_secret: TEAM_DISCORD_TOKEN"
      ].join("\n")
    );
  });

  it("renders telegram surfaces after discord in canonical order", () => {
    const source = renderSpawnfile({
      docs: {
        system: "AGENTS.md"
      },
      execution: {
        model: {
          primary: {
            name: "claude-opus-4-6",
            provider: "anthropic"
          }
        }
      },
      kind: "agent",
      name: "telegram-agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        discord: {},
        telegram: {
          access: {
            mode: "allowlist",
            users: ["123456789"],
            chats: ["-1001234567890"]
          },
          bot_token_secret: "TEAM_TELEGRAM_TOKEN"
        }
      }
    });

    expect(source).toContain(
      [
        "surfaces:",
        "  discord: {}",
        "  telegram:",
        "    access:",
        "      mode: allowlist",
        "      users:",
        "        - \"123456789\"",
        "      chats:",
        "        - \"-1001234567890\"",
        "    bot_token_secret: TEAM_TELEGRAM_TOKEN"
      ].join("\n")
    );
  });

  it("renders whatsapp before slack in canonical order", () => {
    const source = renderSpawnfile({
      kind: "agent",
      name: "multi-surface-agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        slack: {
          access: {
            mode: "allowlist",
            users: ["U1234567890"],
            channels: ["C1234567890"]
          },
          bot_token_secret: "TEAM_SLACK_BOT_TOKEN",
          app_token_secret: "TEAM_SLACK_APP_TOKEN"
        },
        whatsapp: {
          access: {
            mode: "allowlist",
            users: ["15551234567"],
            groups: ["120363400000000000@g.us"]
          }
        }
      }
    });

    expect(source).toContain(
      [
        "surfaces:",
        "  whatsapp:",
        "    access:",
        "      mode: allowlist",
        "      users:",
        "        - \"15551234567\"",
        "      groups:",
        "        - 120363400000000000@g.us",
        "  slack:",
        "    access:",
        "      mode: allowlist",
        "      users:",
        "        - U1234567890",
        "      channels:",
        "        - C1234567890",
        "    bot_token_secret: TEAM_SLACK_BOT_TOKEN",
        "    app_token_secret: TEAM_SLACK_APP_TOKEN"
      ].join("\n")
    );
  });

  it("renders inline model auth and endpoint fields in canonical order", () => {
    const source = renderSpawnfile({
      execution: {
        model: {
          fallback: [
            {
              auth: {
                method: "none"
              },
              endpoint: {
                base_url: "http://host.docker.internal:11434/v1",
                compatibility: "openai"
              },
              name: "qwen2.5:14b",
              provider: "local"
            }
          ],
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
      },
      kind: "agent",
      name: "custom-agent",
      runtime: "picoclaw",
      spawnfile_version: "0.1"
    });

    expect(source).toContain(
      [
        "    primary:",
        "      provider: custom",
        "      name: foo-large",
        "      auth:",
        "        method: api_key",
        "        key: CUSTOM_API_KEY",
        "      endpoint:",
        "        base_url: https://llm.example.com/v1",
        "        compatibility: anthropic"
      ].join("\n")
    );
    expect(source).toContain(
      [
        "    fallback:",
        "      - provider: local",
        "        name: qwen2.5:14b",
        "        auth:",
        "          method: none",
        "        endpoint:",
        "          base_url: http://host.docker.internal:11434/v1",
        "          compatibility: openai"
      ].join("\n")
    );
  });
});
