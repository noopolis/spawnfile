import { describe, expect, it } from "vitest";

import { listAgentSurfaceSecretNames, resolveAgentSurfaces } from "./agentSurfaces.js";

describe("agentSurfaces", () => {
  it("returns undefined when no surfaces are declared", () => {
    expect(resolveAgentSurfaces(undefined)).toBeUndefined();
    expect(listAgentSurfaceSecretNames(undefined)).toEqual([]);
  });

  it("resolves declared surfaces with default secrets and access defaults", () => {
    expect(
      resolveAgentSurfaces({
        discord: {
          access: {
            users: ["987654321098765432"]
          }
        },
        telegram: {
          access: {
            chats: ["-1001234567890"]
          }
        },
        whatsapp: {
          access: {
            groups: ["120363400000000000@g.us"]
          }
        },
        slack: {
          access: {
            channels: ["C1234567890"]
          }
        }
      })
    ).toEqual({
      discord: {
        access: {
          channels: [],
          guilds: [],
          mode: "allowlist",
          users: ["987654321098765432"]
        },
        botTokenSecret: "DISCORD_BOT_TOKEN"
      },
      telegram: {
        access: {
          chats: ["-1001234567890"],
          mode: "allowlist",
          users: []
        },
        botTokenSecret: "TELEGRAM_BOT_TOKEN"
      },
      whatsapp: {
        access: {
          groups: ["120363400000000000@g.us"],
          mode: "allowlist",
          users: []
        }
      },
      slack: {
        access: {
          channels: ["C1234567890"],
          mode: "allowlist",
          users: []
        },
        appTokenSecret: "SLACK_APP_TOKEN",
        botTokenSecret: "SLACK_BOT_TOKEN"
      }
    });
  });

  it("resolves surfaces without access blocks and preserves explicit token secrets", () => {
    expect(
      resolveAgentSurfaces({
        discord: {
          bot_token_secret: "TEAM_DISCORD_TOKEN"
        },
        slack: {
          app_token_secret: "TEAM_SLACK_APP_TOKEN",
          bot_token_secret: "TEAM_SLACK_BOT_TOKEN"
        },
        telegram: {
          bot_token_secret: "TEAM_TELEGRAM_TOKEN"
        }
      })
    ).toEqual({
      discord: {
        botTokenSecret: "TEAM_DISCORD_TOKEN"
      },
      slack: {
        appTokenSecret: "TEAM_SLACK_APP_TOKEN",
        botTokenSecret: "TEAM_SLACK_BOT_TOKEN"
      },
      telegram: {
        botTokenSecret: "TEAM_TELEGRAM_TOKEN"
      }
    });
  });

  it("lists declared surface secret names in sorted order", () => {
    expect(
      listAgentSurfaceSecretNames({
        discord: {
          botTokenSecret: "Z_DISCORD_TOKEN"
        },
        slack: {
          appTokenSecret: "M_SLACK_APP_TOKEN",
          botTokenSecret: "B_SLACK_BOT_TOKEN"
        },
        telegram: {
          botTokenSecret: "A_TELEGRAM_TOKEN"
        }
      })
    ).toEqual([
      "A_TELEGRAM_TOKEN",
      "B_SLACK_BOT_TOKEN",
      "M_SLACK_APP_TOKEN",
      "Z_DISCORD_TOKEN"
    ]);
  });
});
