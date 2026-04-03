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
        },
        whatsapp: {}
      })
    ).toEqual({
      config: {
        discord: {},
        telegram: {},
        whatsapp: {}
      },
      enabled: ["discord", "telegram", "whatsapp"]
    });
  });

  it("allows a single pairing-gated surface and rejects unsupported shapes", () => {
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
        whatsapp: {
          access: {
            groups: [],
            mode: "pairing",
            users: []
          }
        }
      })
    ).not.toThrow();

    expect(() =>
      assertSupportedTinyClawSurfaces({
        http: {
          access: {
            mode: "open"
          },
          pathPrefix: "/v1"
        }
      })
    ).not.toThrow();

    expect(() =>
      assertSupportedTinyClawSurfaces({
        http: { pathPrefix: "/v1" }
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

    expect(() =>
      assertSupportedTinyClawSurfaces({
        whatsapp: {
          access: {
            groups: ["120363400000000000@g.us"],
            mode: "allowlist",
            users: ["15551234567"]
          }
        }
      })
    ).toThrow(/only supports pairing access/);

    expect(() =>
      assertSupportedTinyClawSurfaces({
        whatsapp: {
          access: {
            groups: ["120363400000000000@g.us"],
            mode: "pairing",
            users: []
          }
        }
      })
    ).toThrow(/does not support declarative users or groups/);

    expect(() =>
      assertSupportedTinyClawSurfaces({
        slack: {
          appTokenSecret: "SLACK_APP_TOKEN",
          botTokenSecret: "SLACK_BOT_TOKEN"
        }
      })
    ).toThrow(/does not support Slack/);
  });

  it("rejects multiple interactive conversation scopes", () => {
    expect(() =>
      assertSupportedTinyClawSurfaces({
        discord: {
          access: {
            channels: [],
            guilds: [],
            mode: "pairing",
            users: []
          },
          botTokenSecret: "DISCORD_BOT_TOKEN"
        },
        telegram: {
          access: {
            chats: [],
            mode: "pairing",
            users: []
          },
          botTokenSecret: "TELEGRAM_BOT_TOKEN"
        }
      })
    ).toThrow(/only one interactive conversation scope/);

    expect(() =>
      assertSupportedTinyClawSurfaces({
        moltnet: [
          {
            memberId: "writer",
            network: "local_lab",
            rooms: {
              research: {},
              review: {}
            },
            teamSource: "/tmp/team/Spawnfile"
          }
        ]
      })
    ).toThrow(/only one interactive conversation scope/);

    expect(() =>
      assertSupportedTinyClawSurfaces({
        moltnet: [
          {
            dms: {
              enabled: true
            },
            memberId: "writer",
            network: "local_lab",
            rooms: {
              research: {}
            },
            teamSource: "/tmp/team/Spawnfile"
          }
        ]
      })
    ).toThrow(/only one interactive conversation scope/);
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
            description: "",
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
            description: "",
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

});
