import { describe, expect, it } from "vitest";

import { listAgentSurfaceSecretNames, resolveAgentSurfaces } from "./agentSurfaces.js";

describe("agentSurfaces", () => {
  it("returns undefined when no surfaces are declared", () => {
    expect(resolveAgentSurfaces(undefined)).toBeUndefined();
    expect(resolveAgentSurfaces({})).toBeUndefined();
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
      http: {
        access: {
          mode: "open"
        }
      },
      moltnet: [
        {
          dms: {
            enabled: true,
            read: "all",
            reply: "auto"
          },
          network: "local_lab",
          rooms: {
            research: {
              read: "mentions",
              reply: "manual"
            }
          }
        }
      ],
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
      http: {
        access: {
          mode: "open"
        },
        pathPrefix: "/v1"
      },
      moltnet: [
        {
          dms: {
            enabled: true,
            read: "all",
            reply: "auto"
          },
          memberId: null,
          network: "local_lab",
          rooms: {
            research: {
              read: "mentions",
              reply: "manual"
            }
          },
          teamSource: null
        }
      ],
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

  it("normalizes moltnet attachments with sorted rooms", () => {
    expect(
      resolveAgentSurfaces({
        moltnet: [
          {
            dms: {
              enabled: true
            },
            network: "local_lab",
            rooms: {
              zebra: {},
              alpha: {}
            }
          }
        ]
      })
    ).toEqual({
      moltnet: [
        {
          dms: {
            enabled: true
          },
          memberId: null,
          network: "local_lab",
          rooms: {
            alpha: {},
            zebra: {}
          },
          teamSource: null
        }
      ]
    });
  });
});
