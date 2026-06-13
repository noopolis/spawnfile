import { describe, expect, it } from "vitest";

import {
  assertNetworkBindingEnvUniqueness,
  networkTokenEnvName,
  networkUrlEnvName,
  normalizeNetworkEnvSegment
} from "./networkBinding.js";

describe("normalizeNetworkEnvSegment", () => {
  it("uppercases and replaces non-alphanumeric runs with underscore", () => {
    expect(normalizeNetworkEnvSegment("research-cell")).toBe("RESEARCH_CELL");
    expect(normalizeNetworkEnvSegment("dist_lab")).toBe("DIST_LAB");
    expect(normalizeNetworkEnvSegment("a.b:c")).toBe("A_B_C");
  });
});

describe("env name helpers", () => {
  it("builds URL env names", () => {
    expect(networkUrlEnvName("dist_lab")).toBe("SPAWNFILE_NETWORK_DIST_LAB_URL");
  });

  it("builds per-network and per-member token env names", () => {
    expect(networkTokenEnvName("dist_lab")).toBe("SPAWNFILE_NETWORK_DIST_LAB_TOKEN");
    expect(networkTokenEnvName("dist_lab", "coordinator")).toBe(
      "SPAWNFILE_NETWORK_DIST_LAB_TOKEN_COORDINATOR"
    );
  });
});

describe("assertNetworkBindingEnvUniqueness", () => {
  it("accepts distinct networks and members", () => {
    expect(() =>
      assertNetworkBindingEnvUniqueness([
        { id: "dist_lab", members: ["coordinator", "researcher"] },
        { id: "ops", members: ["lead"] }
      ])
    ).not.toThrow();
  });

  it("uses an unsuffixed token for a single-member network", () => {
    expect(() =>
      assertNetworkBindingEnvUniqueness([{ id: "solo", members: ["only"] }])
    ).not.toThrow();
  });

  it("rejects two network ids that normalize to the same segment", () => {
    expect(() =>
      assertNetworkBindingEnvUniqueness([
        { id: "research-cell", members: ["a"] },
        { id: "research_cell", members: ["b"] }
      ])
    ).toThrow(/collides/);
  });

  it("rejects member ids within a network that collide after normalization", () => {
    expect(() =>
      assertNetworkBindingEnvUniqueness([{ id: "net", members: ["a-b", "a_b"] }])
    ).toThrow(/collides/);
  });

  it("rejects a cross-kind collision between a member token and another network's url", () => {
    // network "n_token" url -> SPAWNFILE_NETWORK_N_TOKEN_URL
    // network "n" member "url" token -> SPAWNFILE_NETWORK_N_TOKEN_URL (collision).
    expect(() =>
      assertNetworkBindingEnvUniqueness([
        { id: "n_token", members: ["x"] },
        { id: "n", members: ["x", "url"] }
      ])
    ).toThrow(/collides/);
  });
});
