import { describe, expect, it } from "vitest";

import {
  assertSupportedOpenClawSurfaces,
  buildOpenClawChannelConfig
} from "./surfaces.js";

describe("openClaw surfaces", () => {
  it("returns no channel config when no surfaces are declared", () => {
    expect(buildOpenClawChannelConfig(undefined)).toEqual({});
  });

  it("builds Telegram open and pairing channel config", () => {
    expect(
      buildOpenClawChannelConfig({
        telegram: {
          access: {
            chats: [],
            mode: "open",
            users: []
          },
          botTokenSecret: "TELEGRAM_BOT_TOKEN"
        }
      })
    ).toEqual({
      telegram: {
        allowFrom: ["*"],
        dmPolicy: "open",
        enabled: true,
        groupPolicy: "open",
        groups: {
          "*": {}
        }
      }
    });

    expect(
      buildOpenClawChannelConfig({
        telegram: {
          access: {
            chats: [],
            mode: "pairing",
            users: []
          },
          botTokenSecret: "TELEGRAM_BOT_TOKEN"
        }
      })
    ).toEqual({
      telegram: {
        dmPolicy: "pairing",
        enabled: true,
        groupPolicy: "disabled"
      }
    });

    expect(
      buildOpenClawChannelConfig({
        telegram: {
          access: {
            chats: [],
            mode: "allowlist",
            users: ["123456789"]
          },
          botTokenSecret: "TELEGRAM_BOT_TOKEN"
        }
      })
    ).toEqual({
      telegram: {
        allowFrom: ["123456789"],
        dmPolicy: "allowlist",
        enabled: true,
        groupPolicy: "disabled"
      }
    });

    expect(
      buildOpenClawChannelConfig({
        telegram: {
          access: {
            chats: ["-1001234567890"],
            mode: "allowlist",
            users: []
          },
          botTokenSecret: "TELEGRAM_BOT_TOKEN"
        }
      })
    ).toEqual({
      telegram: {
        enabled: true,
        groupPolicy: "open",
        groups: {
          "-1001234567890": {}
        }
      }
    });
  });

  it("accepts valid surfaces and rejects ambiguous discord channel allowlists", () => {
    expect(() =>
      assertSupportedOpenClawSurfaces({
        telegram: {
          access: {
            chats: ["-1001234567890"],
            mode: "allowlist",
            users: ["123456789"]
          },
          botTokenSecret: "TELEGRAM_BOT_TOKEN"
        }
      })
    ).not.toThrow();

    expect(() =>
      assertSupportedOpenClawSurfaces({
        discord: {
          access: {
            channels: ["555555555555555555"],
            guilds: ["123", "456"],
            mode: "allowlist",
            users: []
          },
          botTokenSecret: "DISCORD_BOT_TOKEN"
        }
      })
    ).toThrow(/exactly one guild id/);
  });
});
