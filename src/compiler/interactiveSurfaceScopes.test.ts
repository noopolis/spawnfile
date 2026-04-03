import { describe, expect, it } from "vitest";

import { listInteractiveSurfaceScopes } from "./interactiveSurfaceScopes.js";

describe("interactiveSurfaceScopes", () => {
  it("returns an empty list when no interactive surfaces are declared", () => {
    expect(listInteractiveSurfaceScopes(undefined)).toEqual([]);
    expect(listInteractiveSurfaceScopes({ webhook: { url: "https://example.com/hook" } })).toEqual(
      []
    );
  });

  it("lists direct interactive surfaces and moltnet room or dm scopes", () => {
    expect(
      listInteractiveSurfaceScopes({
        discord: {
          botTokenSecret: "DISCORD_BOT_TOKEN"
        },
        http: {
          pathPrefix: "/v1"
        },
        moltnet: [
          {
            dms: {
              enabled: true
            },
            memberId: "writer",
            network: "local_lab",
            rooms: {
              review: {},
              research: {}
            },
            teamSource: "/tmp/team/Spawnfile"
          }
        ],
        telegram: {
          botTokenSecret: "TELEGRAM_BOT_TOKEN"
        }
      })
    ).toEqual([
      "discord",
      "http",
      "moltnet:local_lab:room:research",
      "moltnet:local_lab:room:review",
      "moltnet:local_lab:dms",
      "telegram"
    ]);
  });

  it("ignores disabled moltnet dms", () => {
    expect(
      listInteractiveSurfaceScopes({
        moltnet: [
          {
            dms: {
              enabled: false
            },
            memberId: "writer",
            network: "local_lab",
            teamSource: "/tmp/team/Spawnfile"
          }
        ]
      })
    ).toEqual([]);
  });
});
