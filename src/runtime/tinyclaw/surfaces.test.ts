import { describe, expect, it } from "vitest";

import {
  assertSupportedTinyClawSurfaces,
  buildTinyClawChannels,
  resolveTinyClawSurfaceTokenBindings
} from "./surfaces.js";

describe("tinyClaw surfaces", () => {
  it("builds enabled channel lists for declared surfaces", () => {
    expect(buildTinyClawChannels(undefined)).toEqual({
      config: {},
      enabled: []
    });

    expect(
      buildTinyClawChannels({
        discord: {
          botTokenSecret: "TEAM_DISCORD_TOKEN"
        },
        telegram: {
          botTokenSecret: "TEAM_TELEGRAM_TOKEN"
        }
      })
    ).toEqual({
      config: {
        discord: {},
        telegram: {}
      },
      enabled: ["discord", "telegram"]
    });
  });

  it("resolves no, one, or two surface token bindings", () => {
    expect(
      resolveTinyClawSurfaceTokenBindings([
        {
          emittedFiles: [],
          id: "agent:assistant",
          kind: "agent",
          slug: "assistant",
          value: {
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
          }
        }
      ])
    ).toBeUndefined();

    expect(
      resolveTinyClawSurfaceTokenBindings([
        {
          emittedFiles: [],
          id: "agent:assistant",
          kind: "agent",
          slug: "assistant",
          value: {
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
            subagents: [],
            surfaces: {
              discord: {
                botTokenSecret: "TEAM_DISCORD_TOKEN"
              },
              telegram: {
                botTokenSecret: "TEAM_TELEGRAM_TOKEN"
              }
            }
          }
        }
      ])
    ).toEqual([
      {
        envName: "TEAM_DISCORD_TOKEN",
        jsonPath: "channels.discord.bot_token"
      },
      {
        envName: "TEAM_TELEGRAM_TOKEN",
        jsonPath: "channels.telegram.bot_token"
      }
    ]);
  });

  it("allows pairing-only telegram and rejects declarative telegram allowlists", () => {
    expect(() =>
      assertSupportedTinyClawSurfaces({
        telegram: {
          access: {
            chats: [],
            mode: "pairing",
            users: []
          },
          botTokenSecret: "TELEGRAM_BOT_TOKEN"
        }
      })
    ).not.toThrow();

    expect(() =>
      assertSupportedTinyClawSurfaces({
        telegram: {
          access: {
            chats: ["-1001234567890"],
            mode: "allowlist",
            users: ["123456789"]
          },
          botTokenSecret: "TELEGRAM_BOT_TOKEN"
        }
      })
    ).toThrow(/only supports pairing access/);
  });
});
