import { describe, expect, it } from "vitest";

import { resolveMoltnetAttachments } from "./moltnetResolution.js";

describe("moltnetResolution", () => {
  it("returns undefined when no attachments are declared", () => {
    expect(resolveMoltnetAttachments(undefined, undefined, "researcher")).toBeUndefined();
    expect(resolveMoltnetAttachments([], undefined, "researcher")).toBeUndefined();
  });

  it("resolves team-scoped moltnet attachments with member context", () => {
    expect(
      resolveMoltnetAttachments(
        [
          {
            memberId: null,
            network: "local_lab",
            rooms: {
              research: {
                read: "mentions",
                reply: "auto"
              }
            },
            teamSource: null
          }
        ],
        {
          memberId: "researcher",
          networks: [
            {
              id: "local_lab",
              name: "Local Lab",
              provider: "moltnet",
              rooms: [
                {
                  id: "research",
                  members: ["researcher", "writer"]
                }
              ]
            }
          ],
          teamName: "research-cell",
          teamSource: "/tmp/team/Spawnfile"
        },
        "researcher"
      )
    ).toEqual([
      {
        memberId: "researcher",
        network: "local_lab",
        rooms: {
          research: {
            read: "mentions",
            reply: "auto"
          }
        },
        teamSource: "/tmp/team/Spawnfile"
      }
    ]);
  });

  it("rejects moltnet attachments outside a team context", () => {
    expect(() =>
      resolveMoltnetAttachments(
        [
          {
            memberId: null,
            network: "local_lab",
            teamSource: null
          }
        ],
        undefined,
        "researcher"
      )
    ).toThrow(/not attached to a team network/);
  });

  it("rejects rooms the member does not belong to", () => {
    expect(() =>
      resolveMoltnetAttachments(
        [
          {
            memberId: null,
            network: "local_lab",
            rooms: {
              research: {
                read: "mentions"
              }
            },
            teamSource: null
          }
        ],
        {
          memberId: "writer",
          networks: [
            {
              id: "local_lab",
              name: "Local Lab",
              provider: "moltnet",
              rooms: [
                {
                  id: "research",
                  members: ["researcher"]
                }
              ]
            }
          ],
          teamName: "research-cell",
          teamSource: "/tmp/team/Spawnfile"
        },
        "writer"
      )
    ).toThrow(/is not in that room/);
  });

  it("rejects unknown networks", () => {
    expect(() =>
      resolveMoltnetAttachments(
        [
          {
            dms: {
              enabled: true
            },
            memberId: null,
            network: "missing",
            teamSource: null
          }
        ],
        {
          memberId: "researcher",
          networks: [],
          teamName: "research-cell",
          teamSource: "/tmp/team/Spawnfile"
        },
        "researcher"
      )
    ).toThrow(/unknown Moltnet network missing/);
  });

  it("rejects unknown rooms on known networks", () => {
    expect(() =>
      resolveMoltnetAttachments(
        [
          {
            memberId: null,
            network: "local_lab",
            rooms: {
              missing: {
                read: "all"
              }
            },
            teamSource: null
          }
        ],
        {
          memberId: "researcher",
          networks: [
            {
              id: "local_lab",
              name: "Local Lab",
              provider: "moltnet",
              rooms: [
                {
                  id: "research",
                  members: ["researcher"]
                }
              ]
            }
          ],
          teamName: "research-cell",
          teamSource: "/tmp/team/Spawnfile"
        },
        "researcher"
      )
    ).toThrow(/unknown Moltnet room missing/);
  });
});
