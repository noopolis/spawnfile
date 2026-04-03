import { describe, expect, it } from "vitest";

import type { AgentManifest, TeamManifest } from "../manifest/index.js";

import {
  assertSurfaceMutationAllowed,
  getRuntimeName,
  removeSurface,
  TEAM_SURFACE_COMMAND_ERROR,
  updateSurfaceAccess,
  upsertSurface,
  validateAgentSurfaceSupport
} from "./surfaceDefinitions.js";

const createAgentManifest = (
  overrides: Partial<AgentManifest> = {}
): AgentManifest =>
  ({
    kind: "agent",
    name: "agent",
    runtime: "openclaw",
    ...overrides
  }) as AgentManifest;

const createTeamManifest = (overrides: Partial<TeamManifest> = {}): TeamManifest =>
  ({
    kind: "team",
    members: [],
    name: "team",
    structure: {
      mode: "router"
    },
    ...overrides
  }) as TeamManifest;

describe("surfaceDefinitions", () => {
  it("reads runtime names from string and object bindings", () => {
    expect(getRuntimeName("openclaw")).toBe("openclaw");
    expect(getRuntimeName({ name: "tinyclaw" })).toBe("tinyclaw");
  });

  it("allows agent mutations, skips recursive teams, and rejects direct team writes", () => {
    expect(assertSurfaceMutationAllowed(createAgentManifest(), false)).toBe(true);
    expect(assertSurfaceMutationAllowed(createTeamManifest(), true)).toBe(false);
    expect(() => assertSurfaceMutationAllowed(createTeamManifest(), false)).toThrow(
      TEAM_SURFACE_COMMAND_ERROR
    );
  });

  it("adds per-surface secret configuration and validates invalid secret flags", () => {
    expect(
      upsertSurface(undefined, {
        botTokenSecret: "DISCORD_TOKEN",
        surface: "discord"
      })
    ).toEqual({
      discord: {
        bot_token_secret: "DISCORD_TOKEN"
      }
    });

    expect(
      upsertSurface(undefined, {
        botTokenSecret: "TELEGRAM_TOKEN",
        surface: "telegram"
      })
    ).toEqual({
      telegram: {
        bot_token_secret: "TELEGRAM_TOKEN"
      }
    });

    expect(
      upsertSurface(undefined, {
        surface: "http"
      })
    ).toEqual({
      http: {}
    });

    expect(
      upsertSurface(undefined, {
        surface: "whatsapp"
      })
    ).toEqual({
      whatsapp: {}
    });

    expect(
      upsertSurface(undefined, {
        appTokenSecret: "SLACK_APP_TOKEN",
        botTokenSecret: "SLACK_BOT_TOKEN",
        surface: "slack"
      })
    ).toEqual({
      slack: {
        app_token_secret: "SLACK_APP_TOKEN",
        bot_token_secret: "SLACK_BOT_TOKEN"
      }
    });

    expect(() =>
      upsertSurface(undefined, {
        appTokenSecret: "NOPE",
        surface: "discord"
      })
    ).toThrow(/--app-token-secret is only valid for slack surfaces/i);

    expect(() =>
      upsertSurface(undefined, {
        botTokenSecret: "NOPE",
        surface: "whatsapp"
      })
    ).toThrow(/--bot-token-secret is not valid for whatsapp surfaces/i);

    expect(() =>
      upsertSurface(undefined, {
        botTokenSecret: "NOPE",
        surface: "http"
      })
    ).toThrow(/--bot-token-secret is not valid for http surfaces/i);
  });

  it("builds and normalizes discord allowlists", () => {
    expect(
      updateSurfaceAccess(
        { discord: {} },
        {
          channels: [" C2 ", "C1"],
          guilds: ["G1", "G1"],
          mode: "allowlist",
          surface: "discord",
          users: ["U2", "U1", "U1"]
        },
        "/tmp/Spawnfile",
        false
      )
    ).toEqual({
      discord: {
        access: {
          channels: ["C1", "C2"],
          guilds: ["G1"],
          mode: "allowlist",
          users: ["U1", "U2"]
        }
      }
    });
  });

  it("validates telegram, http, whatsapp, and slack access rules", () => {
    expect(
      updateSurfaceAccess(
        { telegram: {} },
        {
          chats: ["-1001"],
          mode: "allowlist",
          surface: "telegram",
          users: ["42"]
        },
        "/tmp/Spawnfile",
        false
      )
    ).toEqual({
      telegram: {
        access: {
          chats: ["-1001"],
          mode: "allowlist",
          users: ["42"]
        }
      }
    });

    expect(() =>
      updateSurfaceAccess(
        { telegram: {} },
        {
          mode: "allowlist",
          surface: "telegram"
        },
        "/tmp/Spawnfile",
        false
      )
    ).toThrow(/telegram allowlist access requires at least one --user or --chat/i);

    expect(
      updateSurfaceAccess(
        { http: {} },
        {
          mode: "open",
          surface: "http"
        },
        "/tmp/Spawnfile",
        false
      )
    ).toEqual({
      http: {
        access: {
          mode: "open"
        }
      }
    });

    expect(() =>
      updateSurfaceAccess(
        { http: {} },
        {
          mode: "allowlist",
          surface: "http",
          users: ["42"]
        },
        "/tmp/Spawnfile",
        false
      )
    ).toThrow(/http surfaces do not accept allowlist ids/i);

    expect(() =>
      updateSurfaceAccess(
        { http: {} },
        {
          mode: "pairing",
          surface: "http"
        },
        "/tmp/Spawnfile",
        false
      )
    ).toThrow(/http surfaces only support --mode open/i);

    expect(
      updateSurfaceAccess(
        { whatsapp: {} },
        {
          groups: ["group-1"],
          mode: "allowlist",
          surface: "whatsapp",
          users: ["15551234567"]
        },
        "/tmp/Spawnfile",
        false
      )
    ).toEqual({
      whatsapp: {
        access: {
          groups: ["group-1"],
          mode: "allowlist",
          users: ["15551234567"]
        }
      }
    });

    expect(() =>
      updateSurfaceAccess(
        { whatsapp: {} },
        {
          groups: ["group-1"],
          mode: "open",
          surface: "whatsapp"
        },
        "/tmp/Spawnfile",
        false
      )
    ).toThrow(/whatsapp allowlist entries are only valid with --mode allowlist/i);

    expect(
      updateSurfaceAccess(
        { slack: {} },
        {
          channels: ["C123"],
          mode: "allowlist",
          surface: "slack",
          users: ["U123"]
        },
        "/tmp/Spawnfile",
        false
      )
    ).toEqual({
      slack: {
        access: {
          channels: ["C123"],
          mode: "allowlist",
          users: ["U123"]
        }
      }
    });

    expect(
      updateSurfaceAccess(
        { slack: {} },
        {
          mode: "open",
          surface: "slack"
        },
        "/tmp/Spawnfile",
        false
      )
    ).toEqual({
      slack: {
        access: {
          mode: "open"
        }
      }
    });

    expect(() =>
      updateSurfaceAccess(
        { discord: {} },
        {
          mode: "open",
          surface: "discord",
          users: ["U123"]
        },
        "/tmp/Spawnfile",
        false
      )
    ).toThrow(/discord allowlist entries are only valid with --mode allowlist/i);

    expect(() =>
      updateSurfaceAccess(
        { telegram: {} },
        {
          chats: ["-1001"],
          mode: "pairing",
          surface: "telegram"
        },
        "/tmp/Spawnfile",
        false
      )
    ).toThrow(/telegram allowlist entries are only valid with --mode allowlist/i);

    expect(() =>
      updateSurfaceAccess(
        { slack: {} },
        {
          mode: "allowlist",
          surface: "slack"
        },
        "/tmp/Spawnfile",
        false
      )
    ).toThrow(/slack allowlist access requires at least one --user or --channel/i);
  });

  it("handles missing declared surfaces for direct and recursive edits", () => {
    expect(() =>
      updateSurfaceAccess(
        { discord: {} },
        {
          mode: "open",
          surface: "http"
        },
        "/tmp/Spawnfile",
        false
      )
    ).toThrow(/use spawnfile surface add http first/i);

    expect(
      updateSurfaceAccess(
        { telegram: {} },
        {
          mode: "open",
          surface: "whatsapp"
        },
        "/tmp/Spawnfile",
        true
      )
    ).toBeNull();
  });

  it("removes surfaces cleanly and validates runtime support", () => {
    expect(removeSurface(undefined, "discord")).toBeUndefined();
    expect(removeSurface(undefined, "http")).toBeUndefined();
    expect(
      removeSurface(
        {
          discord: {},
          http: {},
          slack: {}
        },
        "discord"
      )
    ).toEqual({
      http: {},
      slack: {}
    });
    expect(removeSurface({ discord: {} }, "discord")).toBeUndefined();

    expect(() =>
      validateAgentSurfaceSupport(
        createAgentManifest({
          name: "tiny",
          runtime: "tinyclaw",
          surfaces: {
            slack: {}
          }
        })
      )
    ).toThrow(/TinyClaw does not support Slack/i);

    expect(() =>
      validateAgentSurfaceSupport(
        createAgentManifest({
          name: "tiny",
          runtime: "tinyclaw",
          surfaces: {
            http: {}
          }
        })
      )
    ).not.toThrow();

    expect(() =>
      validateAgentSurfaceSupport(
        createAgentManifest({
          name: "tiny",
          runtime: "tinyclaw",
          surfaces: {
            discord: {
              access: {
                channels: [],
                guilds: [],
                mode: "pairing",
                users: []
              }
            },
            telegram: {
              access: {
                chats: [],
                mode: "pairing",
                users: []
              }
            }
          }
        })
      )
    ).toThrow(/only one interactive conversation scope/i);

    expect(() =>
      validateAgentSurfaceSupport(
        createAgentManifest({
          name: "tiny",
          runtime: "openclaw",
          surfaces: {
            http: {}
          }
        })
      )
    ).not.toThrow();

    expect(() =>
      validateAgentSurfaceSupport(
        createAgentManifest({
          runtime: undefined as never,
          surfaces: {
            discord: {}
          }
        })
      )
    ).not.toThrow();
  });
});
