import { describe, expect, it } from "vitest";

import { manifestSchema } from "./schemas.js";

describe("surfaceSchemas", () => {
  it("accepts WhatsApp and Slack open access", () => {
    expect(
      manifestSchema.parse({
        kind: "agent",
        name: "agent",
        runtime: "openclaw",
        spawnfile_version: "0.1",
        surfaces: {
          slack: {
            access: {
              mode: "open"
            }
          },
          whatsapp: {
            access: {
              mode: "open"
            }
          }
        }
      })
    ).toMatchObject({
      kind: "agent"
    });
  });

  it("infers allowlist mode from WhatsApp and Slack allowlist entries", () => {
    expect(
      manifestSchema.parse({
        kind: "agent",
        name: "agent",
        runtime: "openclaw",
        spawnfile_version: "0.1",
        surfaces: {
          slack: {
            access: {
              channels: ["C1234567890"],
              users: ["U1234567890"]
            }
          },
          whatsapp: {
            access: {
              groups: ["120363400000000000@g.us"],
              users: ["15551234567"]
            }
          }
        }
      })
    ).toMatchObject({
      kind: "agent"
    });
  });

  it("rejects WhatsApp allowlist entries on non-allowlist access", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        whatsapp: {
          access: {
            groups: ["120363400000000000@g.us"],
            mode: "pairing",
            users: ["15551234567"]
          }
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "whatsapp access users and groups are only valid for allowlist mode"
    );
  });

  it("rejects Slack allowlist entries on non-allowlist access", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        slack: {
          access: {
            channels: ["C1234567890"],
            mode: "pairing",
            users: ["U1234567890"]
          }
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "slack access users and channels are only valid for allowlist mode"
    );
  });

  it("rejects allowlist mode without WhatsApp or Slack entries", () => {
    const whatsapp = manifestSchema.safeParse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        whatsapp: {
          access: {
            mode: "allowlist"
          }
        }
      }
    });

    const slack = manifestSchema.safeParse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        slack: {
          access: {
            mode: "allowlist"
          }
        }
      }
    });

    expect(whatsapp.success).toBe(false);
    expect(whatsapp.error?.issues[0]?.message).toContain(
      "whatsapp allowlist access must declare users or groups"
    );
    expect(slack.success).toBe(false);
    expect(slack.error?.issues[0]?.message).toContain(
      "slack allowlist access must declare users or channels"
    );
  });

  it("rejects empty WhatsApp and Slack access blocks", () => {
    const whatsapp = manifestSchema.safeParse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        whatsapp: {
          access: {}
        }
      }
    });

    const slack = manifestSchema.safeParse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        slack: {
          access: {}
        }
      }
    });

    expect(whatsapp.success).toBe(false);
    expect(whatsapp.error?.issues[0]?.message).toContain(
      "whatsapp access must declare mode or allowlist entries"
    );
    expect(slack.success).toBe(false);
    expect(slack.error?.issues[0]?.message).toContain(
      "slack access must declare mode or allowlist entries"
    );
  });
});
