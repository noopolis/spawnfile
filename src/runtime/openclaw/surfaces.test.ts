import { describe, expect, it } from "vitest";

import {
  assertSupportedOpenClawSurfaces,
  buildOpenClawChannelConfig,
  buildOpenClawSurfaceEnvBindings
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

  it("builds WhatsApp and Slack channel config plus env bindings", () => {
    expect(
      buildOpenClawChannelConfig({
        slack: {
          access: {
            channels: ["C1234567890"],
            mode: "allowlist",
            users: ["U1234567890"]
          },
          appTokenSecret: "TEAM_SLACK_APP_TOKEN",
          botTokenSecret: "TEAM_SLACK_BOT_TOKEN"
        },
        whatsapp: {
          access: {
            groups: ["120363400000000000@g.us"],
            mode: "allowlist",
            users: ["15551234567"]
          }
        }
      })
    ).toEqual({
      slack: {
        allowFrom: ["U1234567890"],
        channels: {
          C1234567890: {
            users: ["U1234567890"]
          }
        },
        dmPolicy: "allowlist",
        enabled: true,
        groupPolicy: "allowlist",
        mode: "socket"
      },
      whatsapp: {
        allowFrom: ["15551234567"],
        dmPolicy: "allowlist",
        enabled: true,
        groupPolicy: "allowlist",
        groups: {
          "120363400000000000@g.us": {}
        }
      }
    });

    expect(
      buildOpenClawSurfaceEnvBindings({
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
      })
    ).toEqual([
      {
        envName: "TEAM_DISCORD_TOKEN",
        jsonPath: "channels.discord.token"
      },
      {
        envName: "TEAM_TELEGRAM_TOKEN",
        jsonPath: "channels.telegram.botToken"
      },
      {
        envName: "TEAM_SLACK_BOT_TOKEN",
        jsonPath: "channels.slack.botToken"
      },
      {
        envName: "TEAM_SLACK_APP_TOKEN",
        jsonPath: "channels.slack.appToken"
      }
    ]);
  });

  it("builds WhatsApp and Slack open, pairing, and default configs", () => {
    expect(
      buildOpenClawChannelConfig({
        slack: {
          access: {
            channels: [],
            mode: "open",
            users: []
          },
          appTokenSecret: "SLACK_APP_TOKEN",
          botTokenSecret: "SLACK_BOT_TOKEN"
        },
        whatsapp: {
          access: {
            groups: [],
            mode: "open",
            users: []
          }
        }
      })
    ).toEqual({
      slack: {
        allowFrom: ["*"],
        dmPolicy: "open",
        enabled: true,
        groupPolicy: "open",
        mode: "socket"
      },
      whatsapp: {
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
        slack: {
          access: {
            channels: [],
            mode: "pairing",
            users: []
          },
          appTokenSecret: "SLACK_APP_TOKEN",
          botTokenSecret: "SLACK_BOT_TOKEN"
        },
        whatsapp: {
          access: {
            groups: [],
            mode: "pairing",
            users: []
          }
        }
      })
    ).toEqual({
      slack: {
        dmPolicy: "pairing",
        enabled: true,
        groupPolicy: "disabled",
        mode: "socket"
      },
      whatsapp: {
        dmPolicy: "pairing",
        enabled: true,
        groupPolicy: "disabled"
      }
    });

    expect(
      buildOpenClawChannelConfig({
        slack: {
          appTokenSecret: "SLACK_APP_TOKEN",
          botTokenSecret: "SLACK_BOT_TOKEN"
        },
        whatsapp: {}
      })
    ).toEqual({
      slack: {
        enabled: true,
        mode: "socket"
      },
      whatsapp: {
        enabled: true
      }
    });

    expect(buildOpenClawSurfaceEnvBindings(undefined)).toBeUndefined();
    expect(buildOpenClawSurfaceEnvBindings({ whatsapp: {} })).toBeUndefined();
  });

  it("builds user-only allowlists for WhatsApp and Slack", () => {
    expect(
      buildOpenClawChannelConfig({
        slack: {
          access: {
            channels: [],
            mode: "allowlist",
            users: ["U1234567890"]
          },
          appTokenSecret: "SLACK_APP_TOKEN",
          botTokenSecret: "SLACK_BOT_TOKEN"
        },
        whatsapp: {
          access: {
            groups: [],
            mode: "allowlist",
            users: ["15551234567"]
          }
        }
      })
    ).toEqual({
      slack: {
        allowFrom: ["U1234567890"],
        dmPolicy: "allowlist",
        enabled: true,
        groupPolicy: "disabled",
        mode: "socket"
      },
      whatsapp: {
        allowFrom: ["15551234567"],
        dmPolicy: "allowlist",
        enabled: true,
        groupPolicy: "disabled"
      }
    });
  });
});
