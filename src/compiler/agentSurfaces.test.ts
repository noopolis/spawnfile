import { describe, expect, it } from "vitest";

import { listAgentSurfaceSecretNames, resolveAgentSurfaces } from "./agentSurfaces.js";

describe("agentSurfaces", () => {
  it("returns undefined when no surfaces are declared", () => {
    expect(resolveAgentSurfaces(undefined)).toBeUndefined();
    expect(listAgentSurfaceSecretNames(undefined)).toEqual([]);
  });

  it("resolves discord and telegram surfaces with default token secrets", () => {
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
      }
    });
  });

  it("resolves surfaces without access blocks and preserves explicit token secrets", () => {
    expect(
      resolveAgentSurfaces({
        discord: {
          bot_token_secret: "TEAM_DISCORD_TOKEN"
        },
        telegram: {
          bot_token_secret: "TEAM_TELEGRAM_TOKEN"
        }
      })
    ).toEqual({
      discord: {
        botTokenSecret: "TEAM_DISCORD_TOKEN"
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
        telegram: {
          botTokenSecret: "A_TELEGRAM_TOKEN"
        }
      })
    ).toEqual(["A_TELEGRAM_TOKEN", "Z_DISCORD_TOKEN"]);
  });
});
