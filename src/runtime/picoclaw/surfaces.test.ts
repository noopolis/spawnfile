import { describe, expect, it } from "vitest";

import {
  assertSupportedPicoClawSurfaces,
  buildPicoClawChannelConfig,
  buildPicoClawSurfaceEnvBindings
} from "./surfaces.js";

describe("picoClaw surfaces", () => {
  it("returns empty config and bindings when no surfaces are declared", () => {
    expect(buildPicoClawChannelConfig(undefined)).toEqual({});
    expect(buildPicoClawSurfaceEnvBindings(undefined)).toBeUndefined();
    expect(buildPicoClawSurfaceEnvBindings({ whatsapp: {} })).toBeUndefined();
  });

  it("builds WhatsApp and Slack channel config with env bindings", () => {
    expect(
      buildPicoClawChannelConfig({
        slack: {
          appTokenSecret: "TEAM_SLACK_APP_TOKEN",
          botTokenSecret: "TEAM_SLACK_BOT_TOKEN"
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
        enabled: true,
        group_trigger: {
          mention_only: true
        }
      },
      whatsapp: {
        allow_from: ["15551234567"],
        enabled: true,
        use_native: true
      }
    });

    expect(
      buildPicoClawSurfaceEnvBindings({
        slack: {
          appTokenSecret: "TEAM_SLACK_APP_TOKEN",
          botTokenSecret: "TEAM_SLACK_BOT_TOKEN"
        }
      })
    ).toEqual([
      {
        envName: "TEAM_SLACK_BOT_TOKEN",
        jsonPath: "channels.slack.bot_token"
      },
      {
        envName: "TEAM_SLACK_APP_TOKEN",
        jsonPath: "channels.slack.app_token"
      }
    ]);
  });

  it("builds Slack allowlist config and rejects pairing modes", () => {
    expect(
      buildPicoClawChannelConfig({
        slack: {
          access: {
            channels: [],
            mode: "allowlist",
            users: ["U1234567890"]
          },
          appTokenSecret: "TEAM_SLACK_APP_TOKEN",
          botTokenSecret: "TEAM_SLACK_BOT_TOKEN"
        }
      })
    ).toEqual({
      slack: {
        allow_from: ["U1234567890"],
        enabled: true,
        group_trigger: {
          mention_only: true
        }
      }
    });

    expect(() =>
      assertSupportedPicoClawSurfaces({
        whatsapp: {
          access: {
            groups: [],
            mode: "pairing",
            users: []
          }
        }
      })
    ).toThrow(/does not support pairing access/);

    expect(() =>
      assertSupportedPicoClawSurfaces({
        slack: {
          access: {
            channels: [],
            mode: "pairing",
            users: []
          },
          appTokenSecret: "SLACK_APP_TOKEN",
          botTokenSecret: "SLACK_BOT_TOKEN"
        }
      })
    ).toThrow(/does not support pairing access/);
  });

  it("rejects unsupported WhatsApp and Slack access shapes", () => {
    expect(() =>
      assertSupportedPicoClawSurfaces({
        whatsapp: {
          access: {
            groups: ["120363400000000000@g.us"],
            mode: "allowlist",
            users: []
          }
        }
      })
    ).toThrow(/only supports user allowlists/);

    expect(() =>
      assertSupportedPicoClawSurfaces({
        slack: {
          access: {
            channels: ["C1234567890"],
            mode: "allowlist",
            users: []
          },
          appTokenSecret: "SLACK_APP_TOKEN",
          botTokenSecret: "SLACK_BOT_TOKEN"
        }
      })
    ).toThrow(/only supports user allowlists/);
  });
});
