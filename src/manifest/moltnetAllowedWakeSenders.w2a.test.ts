import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { manifestSchema, renderSpawnfile } from "./index.js";

describe("moltnet allowed wake senders", () => {
  it("validates optional and ordered allowed_wake_senders in surface schemas", () => {
    const parsedWithSenders = manifestSchema.parse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        moltnet: [
          {
            dms: {
              enabled: true,
              wake: "never",
              allowed_wake_senders: ["zeta", "alpha", "gamma"]
            },
            network: "local_lab"
          },
          {
            dms: {
              enabled: true,
              allowed_wake_senders: []
            },
            network: "other_lab"
          },
          {
            dms: {
              enabled: true,
              wake: "all"
            },
            network: "omitted_lab"
          }
        ]
      }
    });

    expect(parsedWithSenders.surfaces?.moltnet?.[0]?.dms?.allowed_wake_senders).toEqual(
      ["zeta", "alpha", "gamma"]
    );
    expect(parsedWithSenders.surfaces?.moltnet?.[1]?.dms?.allowed_wake_senders).toEqual([]);
    expect(parsedWithSenders.surfaces?.moltnet?.[2]?.dms?.allowed_wake_senders).toBeUndefined();
  });

  it("rejects duplicate and overlong allowed_wake_senders", () => {
    const duplicate = manifestSchema.safeParse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        moltnet: [
          {
            dms: {
              enabled: true,
              allowed_wake_senders: ["world", "world"]
            },
            network: "local_lab"
          }
        ]
      }
    });
    expect(duplicate.success).toBe(false);
    expect(duplicate.error?.issues[0]?.message).toContain("unique");

    const overflow = manifestSchema.safeParse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        moltnet: [
          {
            dms: {
              enabled: true,
              allowed_wake_senders: Array.from({ length: 33 }, (_, index) => `world-${index}`)
            },
            network: "local_lab"
          }
        ]
      }
    });

    expect(overflow.success).toBe(false);
    expect(overflow.error?.issues[0]?.message).toContain("Too big");
  });

  it("rejects unqualified, untrimmed, and invalid wake sender hostnames", () => {
    const badCases = [
      [""],
      [" World"],
      ["World"],
      ["alpha.beta"],
      ["molt://world"],
      ["net:123"],
      ["network#id"]
    ];

    for (const [sender] of badCases) {
      const result = manifestSchema.safeParse({
        kind: "agent",
        name: "agent",
        runtime: "openclaw",
        spawnfile_version: "0.1",
        surfaces: {
          moltnet: [
            {
              dms: {
                enabled: true,
                allowed_wake_senders: [sender]
              },
              network: "local_lab"
            }
          ]
        }
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toContainEqual("surfaces");
    }
  });

  it("renders enabled, wake, then allowed_wake_senders in canonical dms order", () => {
    const rendered = renderSpawnfile({
      kind: "agent",
      name: "researcher",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        moltnet: [
          {
            network: "local_lab",
            dms: {
              allowed_wake_senders: ["zeta", "alpha", "gamma"],
              wake: "never",
              enabled: true
            }
          },
          {
            network: "other_lab",
            dms: {
              allowed_wake_senders: [],
              enabled: true
            }
          }
        ]
      }
    });

    const dmsFirst = rendered.indexOf("      dms:");
    const dmsSecond = rendered.lastIndexOf("      dms:");
    expect(dmsFirst).toBeGreaterThan(-1);
    expect(dmsSecond).toBeGreaterThan(dmsFirst);

    const firstDmStart = rendered.indexOf("      dms:", dmsFirst);
    const firstEnabled = rendered.indexOf("enabled", firstDmStart);
    const firstWake = rendered.indexOf("wake", firstDmStart);
    const firstAllowed = rendered.indexOf("allowed_wake_senders", firstDmStart);
    const secondEnabled = rendered.indexOf("enabled", dmsSecond);
    const secondAllowed = rendered.indexOf("allowed_wake_senders", dmsSecond);

    expect(firstEnabled).toBeGreaterThan(firstDmStart);
    expect(firstWake).toBeGreaterThan(firstEnabled);
    expect(firstAllowed).toBeGreaterThan(firstWake);
    expect(secondEnabled).toBeGreaterThan(dmsSecond);
    expect(secondAllowed).toBeGreaterThan(secondEnabled);

    const parsed = manifestSchema.parse(
      YAML.parse(rendered) as unknown
    ) as { surfaces: { moltnet: Array<{ dms?: { allowed_wake_senders?: string[] } }> } };
    expect(parsed.surfaces.moltnet?.[1]?.dms?.allowed_wake_senders).toEqual([]);
  });

  it("preserves omission of allowed_wake_senders across parse/render round trip", () => {
    const source = renderSpawnfile({
      kind: "agent",
      name: "researcher",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        moltnet: [
          {
            network: "local_lab",
            dms: {
              enabled: true,
              wake: "all"
            }
          }
        ]
      }
    });

    const parsed = manifestSchema.parse(YAML.parse(source) as unknown);
    expect(parsed.surfaces?.moltnet?.[0]?.dms?.allowed_wake_senders).toBeUndefined();
    expect(renderSpawnfile(parsed as typeof parsed)).not.toContain("allowed_wake_senders");
  });
});
